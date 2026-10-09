// Package selfupdate finds a newer release on GitHub and swaps it in for the
// running executable. There is no installer: the exe is the install, so an
// update is a download, a checksum and two renames.
package selfupdate

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// Asset and Sums are the file names the release workflow attaches.
	Asset = "ja-db.exe"
	Sums  = "SHA256SUMS"

	latestURL = "https://api.github.com/repos/Cleancookie/ja-db/releases/latest"
	maxAsset  = 256 << 20
	maxSums   = 64 << 10
)

// Release is what the frontend is told about the newest release.
type Release struct {
	Current string `json:"current"`
	// Latest is empty when nothing has been released yet.
	Latest string `json:"latest"`
	Newer  bool   `json:"newer"`
	Notes  string `json:"notes"`
	URL    string `json:"url"`

	asset, sums string
}

// Checker talks to one releases endpoint; tests point it at a fake.
type Checker struct {
	LatestURL string
	HTTP      *http.Client
}

func GitHub() *Checker {
	return &Checker{LatestURL: latestURL, HTTP: &http.Client{Timeout: 5 * time.Minute}}
}

// Check reports the newest release and whether it is newer than current.
func (c *Checker) Check(ctx context.Context, current string) (Release, error) {
	r := Release{Current: current}
	res, err := c.get(ctx, c.LatestURL)
	if err != nil {
		return r, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return r, nil
	}
	if res.StatusCode != http.StatusOK {
		return r, fmt.Errorf("checking for updates: GitHub answered %s", res.Status)
	}
	var body struct {
		Tag    string `json:"tag_name"`
		Body   string `json:"body"`
		URL    string `json:"html_url"`
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxSums)).Decode(&body); err != nil {
		return r, fmt.Errorf("checking for updates: %w", err)
	}
	r.Latest, r.Notes, r.URL = body.Tag, body.Body, body.URL
	for _, a := range body.Assets {
		switch a.Name {
		case Asset:
			r.asset = a.URL
		case Sums:
			r.sums = a.URL
		}
	}
	cur, okCur := parse(current)
	lat, okLat := parse(r.Latest)
	r.Newer = okCur && okLat && less(cur, lat)
	return r, nil
}

// Apply downloads the newest release over exe. The running file is renamed to
// exe.old — Windows refuses to overwrite a running exe but allows a rename —
// and Cleanup removes it on the next launch.
func (c *Checker) Apply(ctx context.Context, current, exe string) (Release, error) {
	r, err := c.Check(ctx, current)
	if err != nil {
		return r, err
	}
	if !r.Newer {
		return r, errors.New("already up to date")
	}
	if r.asset == "" || r.sums == "" {
		return r, fmt.Errorf("release %s is missing %s or %s", r.Latest, Asset, Sums)
	}
	want, err := c.sum(ctx, r.sums)
	if err != nil {
		return r, err
	}
	fresh := exe + ".new"
	if err := c.download(ctx, r.asset, fresh, want); err != nil {
		_ = os.Remove(fresh)
		return r, err
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		_ = os.Remove(fresh)
		return r, fmt.Errorf("moving the running exe aside: %w", err)
	}
	if err := os.Rename(fresh, exe); err != nil {
		_ = os.Rename(old, exe)
		return r, fmt.Errorf("putting the new exe in place: %w", err)
	}
	return r, nil
}

// Cleanup removes what the previous update moved aside.
// A failure is left for the launch after: the old one may still be exiting.
func Cleanup(exe string) { _ = os.Remove(exe + ".old") }

func (c *Checker) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ja-db")
	return c.HTTP.Do(req)
}

// sum reads the expected hash of Asset from a sha256sum-format file.
func (c *Checker) sum(ctx context.Context, url string) ([]byte, error) {
	res, err := c.get(ctx, url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("downloading %s: %s", Sums, res.Status)
	}
	sc := bufio.NewScanner(io.LimitReader(res.Body, maxSums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == Asset {
			return hex.DecodeString(f[0])
		}
	}
	return nil, fmt.Errorf("%s has no line for %s", Sums, Asset)
}

func (c *Checker) download(ctx context.Context, url, path string, want []byte) error {
	res, err := c.get(ctx, url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: %s", Asset, res.Status)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, maxAsset))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("downloading %s: %w", Asset, err)
	}
	if !bytes.Equal(h.Sum(nil), want) {
		return fmt.Errorf("%s does not match its checksum; not installed", Asset)
	}
	return nil
}

// IsRelease reports whether version names a tagged build rather than "dev"
// or a bare commit, which have nothing to update from.
func IsRelease(version string) bool {
	_, ok := parse(version)
	return ok
}

// parse reads vX.Y.Z, ignoring what git describe appends after it
// (-3-gabc123, -dirty): a build past a tag is not newer than that tag's
// successor, so the base version is all that matters.
func parse(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func less(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

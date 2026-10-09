// Command devserver exposes internal/api.Service over HTTP, so the frontend can
// be developed in a normal browser on a machine with no webview. It is the
// second transport of docs/adr/0001: a pass-through, with no behaviour of its
// own, and not built into the shipped app.
//
// Every route is `POST /api/<Method>` with a JSON body, where <Method> is the
// exported method name on App (app.go) — frontend/src/api.ts uses one string to
// find a Wails binding and to build this URL, so the spellings must agree.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/api"
	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:34567", "listen address; must be loopback")
	dir := flag.String("dir", "", "config directory (default: the desktop app's)")
	flag.Parse()

	if err := requireLoopback(*addr); err != nil {
		log.Fatalf("devserver: %v", err)
	}
	svc, err := build(*dir)
	if err != nil {
		log.Fatalf("devserver: %v", err)
	}
	defer svc.Shutdown()

	// Serve until interrupted rather than log.Fatal-ing out of ListenAndServe,
	// which would skip the deferred Shutdown and leave the activity log's temp
	// directory behind.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{
		Addr:    *addr,
		Handler: newHandler(svc),
		// A client that never finishes its headers would hold a connection open.
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("devserver listening on http://%s", *addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Printf("devserver: %v", err)
		svc.Shutdown()
		os.Exit(1)
	}
}

// requireLoopback refuses any address that is reachable from another machine.
// This server runs SQL against saved connections for whoever can reach it.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("bad -addr %q: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("-addr %q is not loopback; refusing to serve saved connections", addr)
	}
	return nil
}

// build wires the same Service app.go does. The wiring is repeated rather than
// shared: each transport is small, and sharing it would couple them for no gain.
func build(dir string) (*api.Service, error) {
	if dir == "" {
		var err error
		if dir, err = config.DefaultDir(); err != nil {
			return nil, err
		}
	}
	store, err := config.Open(dir)
	if err != nil {
		return nil, err
	}
	settings, err := config.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		return nil, err
	}
	return api.New(store, settings, engine.New(), activity.New()), nil
}

// route decodes its own body and calls one Service method.
type route func(ctx context.Context, body []byte) (any, error)

func decode[T any](body []byte) (T, error) {
	var v T
	if len(body) == 0 {
		return v, nil
	}
	err := json.Unmarshal(body, &v)
	return v, err
}

// withReq adapts a method taking a context and one request struct.
func withReq[Req, Res any](f func(context.Context, Req) (Res, error)) route {
	return func(ctx context.Context, body []byte) (any, error) {
		req, err := decode[Req](body)
		if err != nil {
			return nil, err
		}
		return f(ctx, req)
	}
}

// withArgs adapts the methods whose parameters are loose scalars, which
// api.ts sends as one object.
func withArgs(f func(ctx context.Context, a args) (any, error)) route {
	return func(ctx context.Context, body []byte) (any, error) {
		a, err := decode[args](body)
		if err != nil {
			return nil, err
		}
		return f(ctx, a)
	}
}

// args is the union of the loose-scalar methods' parameters.
type args struct {
	ID       string           `json:"id"`
	Database string           `json:"database"`
	Ref      driver.ObjectRef `json:"ref"`
	Line     string           `json:"line"`
}

func routes(s *api.Service) map[string]route {
	return map[string]route{
		"Drivers":           withArgs(func(context.Context, args) (any, error) { return s.Drivers(), nil }),
		"ListConnections":   withArgs(func(context.Context, args) (any, error) { return s.ListConnections(), nil }),
		"ConnectedIDs":      withArgs(func(context.Context, args) (any, error) { return s.ConnectedIDs(), nil }),
		"GetSettings":       withArgs(func(context.Context, args) (any, error) { return s.GetSettings(), nil }),
		"SecretBackend":     withArgs(func(context.Context, args) (any, error) { return s.SecretBackend(), nil }),
		"Activity":          withArgs(func(context.Context, args) (any, error) { return s.Activity(), nil }),
		"QuerySQL":          withArgs(func(_ context.Context, a args) (any, error) { return s.QuerySQL(a.ID), nil }),
		"ClearQueryHistory": withArgs(func(context.Context, args) (any, error) { s.ClearQueryHistory(); return nil, nil }),
		"CancelQuery":       withArgs(func(_ context.Context, a args) (any, error) { s.CancelQuery(a.ID); return nil, nil }),
		"CancelSQL":         withArgs(func(_ context.Context, a args) (any, error) { s.CancelSQL(a.ID, a.Database); return nil, nil }),
		"CancelConnectionQueries": withArgs(func(_ context.Context, a args) (any, error) {
			s.CancelConnectionQueries(a.ID)
			return nil, nil
		}),
		"OpenSample":       withArgs(func(context.Context, args) (any, error) { return s.OpenSample() }),
		"ResetSample":      withArgs(func(context.Context, args) (any, error) { return s.ResetSample() }),
		"Disconnect":       withArgs(func(_ context.Context, a args) (any, error) { s.Disconnect(a.ID); return nil, nil }),
		"DeleteConnection": withArgs(func(_ context.Context, a args) (any, error) { return nil, s.DeleteConnection(a.ID) }),
		"LogClient":        withArgs(func(_ context.Context, a args) (any, error) { s.LogClient(a.Line); return nil, nil }),
		"ListDatabases":    withArgs(func(ctx context.Context, a args) (any, error) { return s.ListDatabases(ctx, a.ID) }),
		"ListObjects": withArgs(func(ctx context.Context, a args) (any, error) {
			return s.ListObjects(ctx, a.ID, a.Database)
		}),
		"ListColumns": withArgs(func(ctx context.Context, a args) (any, error) {
			return s.ListColumns(ctx, a.ID, a.Ref)
		}),
		"DescribeObject": withArgs(func(ctx context.Context, a args) (any, error) {
			return s.DescribeObject(ctx, a.ID, a.Ref)
		}),
		// The devserver is never a release, so it reports and refuses as one.
		"CheckUpdate": withArgs(func(ctx context.Context, _ args) (any, error) { return s.CheckUpdate(ctx, "dev") }),
		"ApplyUpdate": withArgs(func(ctx context.Context, _ args) (any, error) {
			_, err := s.ApplyUpdate(ctx, "dev")
			return nil, err
		}),

		"SaveConnection": withReq(func(_ context.Context, r api.SaveConnectionRequest) (any, error) {
			return s.SaveConnection(r)
		}),
		"TestConnection": withReq(func(_ context.Context, r api.SaveConnectionRequest) (any, error) {
			return nil, s.TestConnection(r)
		}),
		"DescribeTLS": withReq(func(_ context.Context, c config.Connection) (any, error) {
			return s.DescribeTLS(c)
		}),
		"SaveSettings": withReq(func(_ context.Context, v config.Settings) (any, error) {
			return s.SaveSettings(v)
		}),
		"PreviewCreateTable": withReq(func(_ context.Context, r api.CreateTableRequest) (any, error) {
			return s.PreviewCreateTable(r)
		}),

		"Connect":        withReq(s.Connect),
		"ReadRows":       withReq(s.ReadRows),
		"ReadCell":       withReq(s.ReadCell),
		"CountRows":      withReq(s.CountRows),
		"PreviewChanges": withReq(s.PreviewChanges),
		"ApplyChanges":   withReq(s.ApplyChanges),
		"RunSQL":         withReq(s.RunSQL),
		"TruncateTable":  withReq(s.TruncateTable),
		"DropObject":     withReq(s.DropObject),
		"CreateTable":    withReq(s.CreateTable),
	}
}

// maxBody bounds one request. A change set with large cell values is the
// biggest legitimate body; nothing real comes near this.
const maxBody = 64 << 20

// loopbackHostPort accepts a Host header naming this machine, on any port. The
// port does not matter: a DNS-rebinding page is recognised by its hostname,
// which is the attacker's own, and the Vite proxy on :5173 forwards the browser's
// Host unchanged.
func loopbackHostPort(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	return loopbackName(host)
}

// loopbackOrigin accepts a page served by
// this machine. Anything else is a page on another site calling in.
func loopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return loopbackName(u.Hostname())
}

func loopbackName(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func newHandler(s *api.Service) http.Handler {
	table := routes(s)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHostPort(r.Host) {
			http.Error(w, "bad Host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !loopbackOrigin(o) {
			http.Error(w, "bad Origin", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		// A cross-origin page can send a "simple" POST to loopback without a
		// preflight, and this server runs SQL. Requiring application/json makes
		// that a preflighted request, which nothing here answers.
		if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
			http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		h, ok := table[strings.TrimPrefix(r.URL.Path, "/api/")]
		if !ok {
			http.Error(w, "unknown method", http.StatusNotFound)
			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		result, err := h(r.Context(), body)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(result)
	})
}

package config

import (
	"fmt"
	"log"
	"os"
	"sort"
)

// migrateFileSecrets moves every entry of the legacy plaintext secrets.json into
// dst. Per entry: Set, read back, compare, and only then remove it from the
// file. The file is deleted when it is empty.
//
// It never deletes a secret before the keyring has returned the same value, and
// it stops at the first failure so the next start retries from where it left
// off. Whatever could not be moved is returned so the Store can still read it;
// nil means nothing is left.
func migrateFileSecrets(path string, dst SecretStore) *FileSecrets {
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	src, err := NewFileSecrets(path)
	if err != nil {
		log.Printf("ja-db: not migrating %s: %v", path, err)
		return nil
	}
	refs := make([]string, 0, len(src.values))
	for ref := range src.values {
		refs = append(refs, ref)
	}
	sort.Strings(refs)

	moved := 0
	for _, ref := range refs {
		if err := moveSecret(src, dst, ref); err != nil {
			log.Printf("ja-db: migrating passwords to the OS keyring stopped after %d of %d: %v; %s left in place",
				moved, len(refs), err, path)
			return src
		}
		moved++
	}
	if err := os.Remove(path); err != nil {
		log.Printf("ja-db: migrated %d passwords but could not remove %s: %v", moved, path, err)
		return nil
	}
	if moved > 0 {
		log.Printf("ja-db: moved %d passwords from %s into the OS keyring", moved, path)
	}
	return nil
}

func moveSecret(src *FileSecrets, dst SecretStore, ref string) error {
	want, _ := src.Get(ref)
	if err := dst.Set(ref, want); err != nil {
		return fmt.Errorf("writing %s: %w", ref, err)
	}
	got, err := dst.Get(ref)
	if err != nil {
		return fmt.Errorf("reading %s back: %w", ref, err)
	}
	if got != want {
		// Do not leave a wrong password in the keyring shadowing the right one.
		_ = dst.Delete(ref)
		return fmt.Errorf("%s read back different from what was written", ref)
	}
	return src.Delete(ref)
}

package driver

import (
	"net/url"
	"strings"
	"testing"
)

func dsnOf(t *testing.T, cfg ConnConfig) string {
	t.Helper()
	d, err := Get(cfg.Kind)
	if err != nil {
		t.Fatal(err)
	}
	dsn, err := d.DSN(cfg, "")
	if err != nil {
		t.Fatalf("DSN: %v", err)
	}
	return dsn
}

func TestIsLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"": true, "localhost": true, "LOCALHOST": true, "127.0.0.1": true, "::1": true, "[::1]": true,
		"db.localhost": true, "/var/run/postgresql": true,
		"10.0.0.5": false, "db.example.com": false, "0.0.0.0": false,
	} {
		if got := IsLoopbackHost(host); got != want {
			t.Errorf("IsLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestPostgresTLSDefaults(t *testing.T) {
	remote := dsnOf(t, ConnConfig{Kind: KindPostgres, Host: "db.example.com"})
	if !strings.Contains(remote, "sslmode=verify-full") {
		t.Errorf("remote default should verify: %s", remote)
	}
	local := dsnOf(t, ConnConfig{Kind: KindPostgres, Host: "localhost"})
	if !strings.Contains(local, "sslmode=prefer") {
		t.Errorf("loopback default should stay prefer: %s", local)
	}
	chosen := dsnOf(t, ConnConfig{Kind: KindPostgres, Host: "db.example.com", SSLMode: "require"})
	if !strings.Contains(chosen, "sslmode=require") {
		t.Errorf("explicit mode must win: %s", chosen)
	}
}

func TestMySQLTLSDefaults(t *testing.T) {
	if got := dsnOf(t, ConnConfig{Kind: KindMySQL, Host: "db.example.com"}); !strings.Contains(got, "tls=true") {
		t.Errorf("remote default should verify: %s", got)
	}
	if got := dsnOf(t, ConnConfig{Kind: KindMySQL, Host: "127.0.0.1"}); !strings.Contains(got, "tls=preferred") {
		t.Errorf("loopback default should be preferred: %s", got)
	}
}

func mssqlQuery(t *testing.T, cfg ConnConfig) url.Values {
	t.Helper()
	cfg.Kind = KindMSSQL
	u, err := url.Parse(dsnOf(t, cfg))
	if err != nil {
		t.Fatal(err)
	}
	return u.Query()
}

func TestMSSQLTrustIsAnExplicitOptIn(t *testing.T) {
	cases := []struct {
		name  string
		cfg   ConnConfig
		trust string
		level string
	}{
		{"remote default verifies", ConnConfig{Host: "db.example.com"}, "false", TLSVerified},
		{"loopback legacy default trusts", ConnConfig{Host: "localhost"}, "true", TLSEncrypted},
		{"remote opt-in trusts", ConnConfig{Host: "db.example.com", SSLMode: "true", TrustServerCertificate: true}, "true", TLSEncrypted},
		{"loopback with a chosen mode verifies", ConnConfig{Host: "localhost", SSLMode: "true"}, "false", TLSVerified},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q := mssqlQuery(t, c.cfg)
			if q.Get("TrustServerCertificate") != c.trust {
				t.Errorf("TrustServerCertificate = %q, want %q", q.Get("TrustServerCertificate"), c.trust)
			}
			cfg := c.cfg
			cfg.Kind = KindMSSQL
			if got := (mssqlDriver{}).TLS(cfg).Level; got != c.level {
				t.Errorf("level = %s, want %s", got, c.level)
			}
		})
	}
}

func TestSSLModeAllowList(t *testing.T) {
	bad := map[Kind]string{KindPostgres: "verify_full", KindMySQL: "custom", KindMSSQL: "yes"}
	for kind, mode := range bad {
		d, _ := Get(kind)
		if _, err := d.DSN(ConnConfig{Kind: kind, Host: "h", SSLMode: mode}, ""); err == nil {
			t.Errorf("%s accepted SSL mode %q", kind, mode)
		}
		for _, ok := range d.Caps().SSLModes {
			if _, err := d.DSN(ConnConfig{Kind: kind, Host: "h", SSLMode: ok}, ""); err != nil {
				t.Errorf("%s rejected its own mode %q: %v", kind, ok, err)
			}
		}
	}
}

func TestParamsCannotOverrideTLS(t *testing.T) {
	for kind, key := range map[Kind]string{
		KindPostgres: "SSLMode", KindMySQL: "tls", KindMSSQL: "trustservercertificate",
	} {
		d, _ := Get(kind)
		cfg := ConnConfig{Kind: kind, Host: "h", Params: map[string]string{key: "disable"}}
		if _, err := d.DSN(cfg, ""); err == nil {
			t.Errorf("%s: Params[%q] overrode TLS", kind, key)
		}
		if err := ValidateConn(d, cfg); err == nil {
			t.Errorf("%s: ValidateConn accepted Params[%q]", kind, key)
		}
	}
}

func TestTLSWarnsOnlyForRemoteHosts(t *testing.T) {
	d, _ := Get(KindPostgres)
	if !d.TLS(ConnConfig{Host: "db.example.com", SSLMode: "disable"}).Warn {
		t.Error("remote plaintext should warn")
	}
	if d.TLS(ConnConfig{Host: "localhost", SSLMode: "disable"}).Warn {
		t.Error("loopback plaintext should not warn")
	}
	if d.TLS(ConnConfig{Host: "db.example.com"}).Warn {
		t.Error("remote default is verified")
	}
}

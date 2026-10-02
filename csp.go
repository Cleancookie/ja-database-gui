package main

import "net/http"

// contentSecurityPolicy is sent with every asset the webview loads. The built
// frontend has no inline script, no eval and no remote origin, so scripts,
// connections and everything not listed are same-origin only. Styles keep
// 'unsafe-inline' because CodeMirror and Radix write <style> and style="".
//
// Not applied by `make web`: Vite's dev server injects inline scripts for hot
// reload, which this would block. Docs: docs/SECURITY-AUDIT.md (B11).
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'"

// withCSP adds the policy header to every response of next.
func withCSP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		next.ServeHTTP(w, r)
	})
}

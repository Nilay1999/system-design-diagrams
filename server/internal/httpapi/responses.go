package httpapi

import "net/http"

// The generated 302/204 responses can't carry Set-Cookie headers, so the auth handlers
// return these instead. Each implements the generated response interfaces it's used for.

type redirect struct {
	location string
	cookies  []*http.Cookie
}

func (r redirect) write(w http.ResponseWriter) error {
	for _, c := range r.cookies {
		http.SetCookie(w, c)
	}
	w.Header().Set("Location", r.location)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusFound)
	return nil
}

func (r redirect) VisitGithubLoginResponse(w http.ResponseWriter) error    { return r.write(w) }
func (r redirect) VisitGithubCallbackResponse(w http.ResponseWriter) error { return r.write(w) }

type noContent struct {
	cookies []*http.Cookie
}

func (n noContent) VisitLogoutResponse(w http.ResponseWriter) error {
	for _, c := range n.cookies {
		http.SetCookie(w, c)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

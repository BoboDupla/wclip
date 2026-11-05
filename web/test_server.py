#!/usr/bin/env python3
"""Tests for the wclip web front end.

Run from anywhere: python3 web/test_server.py

Stdlib only, like the app. The module is imported with HOME and
WCLIP_WEB_ARTICLES pointed at a temporary tree, so nothing here touches the
real ~/.config/wclip-web or the real articles folder. A real HTTP server is
started on an ephemeral port, because the interesting behaviour (response
headers, cookie handling, CL validation) lives in the request path.
"""
import base64
import http.client
import importlib.util
import os
import secrets
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="wclip-web-test-")
ARTICLES = os.path.join(TMP, "articles")
os.makedirs(os.path.join(ARTICLES, "html"), exist_ok=True)
os.environ["HOME"] = TMP
os.environ["WCLIP_WEB_ARTICLES"] = ARTICLES

spec = importlib.util.spec_from_file_location("wclip_web", os.path.join(HERE, "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

PASSWORD = "correct horse battery"
srv.write_auth({
    "user": "tester",
    "password_hash": srv.hash_password(PASSWORD),
    "secret": base64.b64encode(secrets.token_bytes(32)).decode(),
    "session_days": "1",
})

STEM = "a-test-note"
with open(os.path.join(ARTICLES, STEM + ".md"), "w", encoding="utf-8") as f:
    f.write("---\ntitle: A test note\ncreated: 2026-11-05\nread: false\n---\n\nBody.\n")
with open(os.path.join(ARTICLES, "html", STEM + ".html"), "w", encoding="utf-8") as f:
    f.write("<html><head><title>t</title></head><body><p>third-party</p></body></html>")
with open(os.path.join(ARTICLES, "old-note.md"), "w", encoding="utf-8") as f:
    f.write("---\ntitle: Old note\ncreated: 2026-01-01\nread: false\n---\n\nBody.\n")
with open(os.path.join(ARTICLES, "html", "old-note.html"), "w", encoding="utf-8") as f:
    # A rendition written before the meta CSP existed.
    f.write("<html><head><title>old</title></head><body><p>old</p></body></html>")

HTTPD = srv.ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
PORT = HTTPD.server_address[1]
threading.Thread(target=HTTPD.serve_forever, daemon=True).start()


def request(method, path, body=None, headers=None, cookie=None):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    hdrs = dict(headers or {})
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None and "Content-Type" not in hdrs:
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    conn.request(method, path, body=body, headers=hdrs)
    r = conn.getresponse()
    data = r.read()
    out = (r.status, dict(r.getheaders()), data)
    conn.close()
    return out


def login():
    body = "user=tester&password=%s" % PASSWORD.replace(" ", "+")
    status, headers, _ = request("POST", "/login", body)
    assert status == 303, status
    return headers["Set-Cookie"].split(";")[0]


class PureHelpers(unittest.TestCase):
    def test_safe_next(self):
        self.assertEqual(srv.safe_next("/articles"), "/articles")
        self.assertEqual(srv.safe_next("/article/x/view"), "/article/x/view")
        self.assertEqual(srv.safe_next("/a?b=1"), "/a?b=1")
        for bad in ("/\\evil.com", "\\evil.com", "//evil.com", "https://evil.com",
                    "javascript:alert(1)", "", None):
            self.assertEqual(srv.safe_next(bad, "/DEF"), "/DEF", bad)

    def test_valid_clip_url(self):
        self.assertTrue(srv.valid_clip_url("https://example.com/a"))
        self.assertTrue(srv.valid_clip_url("HTTP://example.com/a"))
        self.assertFalse(srv.valid_clip_url("file:///etc/passwd"))
        self.assertFalse(srv.valid_clip_url("https://example.com/a\nClipped: /tmp/x.md"))
        self.assertFalse(srv.valid_clip_url("https://example.com/a\r\nX: y"))
        self.assertFalse(srv.valid_clip_url("https://example.com/" + "a" * 2048))

    def test_containment(self):
        self.assertTrue(srv.contained_in_articles(os.path.join(ARTICLES, STEM + ".md")))
        self.assertTrue(srv.contained_in_articles(os.path.join(ARTICLES, "html", STEM + ".html")))
        self.assertFalse(srv.contained_in_articles("/etc/passwd"))
        self.assertFalse(srv.contained_in_articles(os.path.join(ARTICLES, "..", "x.md")))
        link = os.path.join(ARTICLES, "link.md")
        os.symlink("/etc/passwd", link)
        try:
            self.assertFalse(srv.contained_in_articles(link))
        finally:
            os.unlink(link)

    def test_article_policy_keeps_downloads(self):
        csp = srv.ARTICLE_CSP
        self.assertIn("script-src 'none'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("sandbox allow-downloads", csp)

    def test_handler_timeout(self):
        self.assertEqual(srv.Handler.timeout, 30)


class Headers(unittest.TestCase):
    def test_login_page_carries_app_headers(self):
        status, headers, _ = request("GET", "/login")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_old_rendition_gets_header_csp(self):
        cookie = login()
        status, headers, body = request("GET", "/article/old-note/html", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn(b"old", body)
        self.assertIn("sandbox allow-downloads", headers["Content-Security-Policy"])
        self.assertIn("script-src 'none'", headers["Content-Security-Policy"])

    def test_view_carries_header_csp(self):
        cookie = login()
        status, headers, _ = request("GET", "/article/%s/view" % STEM, cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn("sandbox allow-downloads", headers["Content-Security-Policy"])

    def test_markdown_download_has_no_sandbox(self):
        cookie = login()
        status, headers, _ = request("GET", "/article/%s/md" % STEM, cookie=cookie)
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Disposition"].startswith("attachment"))
        self.assertNotIn("sandbox", headers["Content-Security-Policy"])


class Login(unittest.TestCase):
    def test_login_redirect_is_local(self):
        body = "user=tester&password=%s&next=%%2F%%5Cevil.com" % PASSWORD.replace(" ", "+")
        status, headers, _ = request("POST", "/login", body)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/articles")

    def test_login_keeps_safe_next(self):
        body = ("user=tester&password=%s&next=%%2Farticles%%3Funread%%3D1"
                % PASSWORD.replace(" ", "+"))
        status, headers, _ = request("POST", "/login", body)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/articles?unread=1")

    def test_wrong_password_is_401(self):
        status, _, _ = request("POST", "/login", "user=tester&password=nope")
        self.assertEqual(status, 401)


class RequestValidation(unittest.TestCase):
    def test_newline_in_url_is_rejected(self):
        cookie = login()
        body = "url=https%3A%2F%2Fexample.com%2Fx%0AClipped%3A+%2Ftmp%2Fpwn.md"
        status, _, _ = request("POST", "/clip", body, cookie=cookie)
        self.assertEqual(status, 400)

    def test_bad_content_length_is_400(self):
        s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
        s.sendall(b"POST /login HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                  b"Content-Length: banana\r\n\r\n")
        data = s.recv(4096)
        s.close()
        self.assertIn(b"400", data.split(b"\r\n", 1)[0])

    def test_negative_content_length_is_400(self):
        s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
        s.sendall(b"POST /login HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                  b"Content-Length: -5\r\n\r\n")
        data = s.recv(4096)
        s.close()
        self.assertIn(b"400", data.split(b"\r\n", 1)[0])

    def test_oversized_clip_is_413(self):
        cookie = login()
        status, _, _ = request("POST", "/clip", "url=" + "a" * 9000, cookie=cookie)
        self.assertEqual(status, 413)

    def test_unknown_article_is_404(self):
        cookie = login()
        status, _, _ = request("GET", "/article/nope/html", cookie=cookie)
        self.assertEqual(status, 404)

    def test_traversal_stem_is_404(self):
        cookie = login()
        status, _, _ = request("GET", "/article/..%2F..%2Fetc%2Fpasswd/html", cookie=cookie)
        self.assertEqual(status, 404)


class CrossSite(unittest.TestCase):
    def test_clip_from_another_site_is_refused(self):
        cookie = login()
        status, _, _ = request("POST", "/clip", "url=https%3A%2F%2Fexample.com",
                               headers={"Sec-Fetch-Site": "cross-site"}, cookie=cookie)
        self.assertEqual(status, 403)

    def test_toggle_from_another_site_is_refused(self):
        cookie = login()
        status, _, _ = request("GET", "/toggle?stem=%s&to=0" % STEM,
                               headers={"Sec-Fetch-Site": "cross-site"}, cookie=cookie)
        self.assertEqual(status, 403)

    def test_non_browser_client_still_works(self):
        # No Sec-Fetch-Site at all (Shortcut, curl): the request reaches validation.
        cookie = login()
        status, _, _ = request("POST", "/clip", "url=ftp%3A%2F%2Fexample.com", cookie=cookie)
        self.assertEqual(status, 400)

    def test_same_origin_is_allowed(self):
        cookie = login()
        status, _, _ = request("POST", "/clip", "url=ftp%3A%2F%2Fexample.com",
                               headers={"Sec-Fetch-Site": "same-origin"}, cookie=cookie)
        self.assertEqual(status, 400)


class Lockout(unittest.TestCase):
    def tearDown(self):
        srv.clear_global_failures()

    def test_backoff_thresholds(self):
        self.assertEqual(srv.global_backoff(9), 0)
        self.assertEqual(srv.global_backoff(10), 900)
        self.assertEqual(srv.global_backoff(20), 3600)
        self.assertEqual(srv.global_backoff(30), 4 * 3600)

    def test_ten_failures_lock_globally(self):
        now = 1_000_000.0
        for _ in range(9):
            srv.note_global_failure(now)
        self.assertFalse(srv.globally_blocked(now + 1))
        srv.note_global_failure(now)
        self.assertTrue(srv.globally_blocked(now + 1))
        self.assertTrue(890 <= srv.global_wait(now + 1) <= 900)
        self.assertFalse(srv.globally_blocked(now + 901))

    def test_failures_age_out_of_the_window(self):
        now = 2_000_000.0
        for _ in range(9):
            srv.note_global_failure(now - srv.GLOBAL_WINDOW - 10)
        srv.note_global_failure(now)
        # The old ones were pruned, so this is one failure, not ten.
        self.assertFalse(srv.globally_blocked(now + 1))

    def test_clear_on_success(self):
        for _ in range(12):
            srv.note_global_failure()
        self.assertTrue(srv.globally_blocked())
        srv.clear_global_failures()
        self.assertFalse(srv.globally_blocked())

    def test_prune_drops_stale_ip_entries(self):
        now = time.time()
        srv.LOGIN_FAILS["203.0.113.9"] = [now - srv.LOGIN_WINDOW - 1]
        srv.LOGIN_FAILS["198.51.100.7"] = [now - 1]
        srv.prune()
        self.assertNotIn("203.0.113.9", srv.LOGIN_FAILS)
        self.assertIn("198.51.100.7", srv.LOGIN_FAILS)


def main():
    try:
        unittest.main(verbosity=2, exit=False)
    finally:
        HTTPD.shutdown()
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()

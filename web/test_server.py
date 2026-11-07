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
import contextlib
import html
import http.client
import io
import queue
import importlib.util
import os
import json
import re
import secrets
import shlex
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

    def test_article_policy_forbids_active_content(self):
        # The reading view is third-party HTML on our origin: no scripts, no forms, no
        # frames, no external CSS. `sandbox` is deliberately absent: an opaque origin
        # broke link clicks in some browsers, and with active content already banned it
        # bought nothing worth that.
        csp = srv.ARTICLE_CSP
        self.assertIn("script-src 'none'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("form-action 'none'", csp)
        self.assertIn("base-uri 'none'", csp)
        self.assertNotIn("sandbox", csp)

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
        self.assertIn("script-src 'none'", headers["Content-Security-Policy"])
        self.assertIn("form-action 'none'", headers["Content-Security-Policy"])

    def test_view_carries_header_csp(self):
        cookie = login()
        status, headers, _ = request("GET", "/article/%s/view" % STEM, cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn("script-src 'none'", headers["Content-Security-Policy"])
        self.assertNotIn("sandbox", headers["Content-Security-Policy"])

    def test_markdown_download_has_no_csp_limits(self):
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

    def test_reading_view_bar_link_is_signed(self):
        # The bar link is minted with an HMAC over stem+target, so it also works from a
        # request that looks cross-site (that is what the sandbox used to cause).
        cookie = login()
        status, _, body = request("GET", "/article/old-note/view", cookie=cookie)
        self.assertEqual(status, 200)
        page = body.decode("utf-8")
        link = re.search(r'href="(/toggle\?[^"]+)"', page)
        self.assertIsNotNone(link, page[:500])
        url = html.unescape(link.group(1))
        self.assertIn("&s=", url)
        status, _, _ = request("GET", url, headers={"Sec-Fetch-Site": "cross-site"},
                               cookie=cookie)
        self.assertEqual(status, 303)
        note = open(os.path.join(ARTICLES, "old-note.md"), encoding="utf-8").read()
        self.assertIn("read: true", note)
        srv.set_read("old-note", False)

    def test_signed_toggle_for_a_different_target_is_refused(self):
        cookie = login()
        _, _, body = request("GET", "/article/old-note/view", cookie=cookie)
        url = html.unescape(re.search(r'href="(/toggle\?[^"]+)"',
                                      body.decode("utf-8")).group(1))
        tampered = url.replace("to=1", "to=0")
        self.assertNotEqual(url, tampered)
        status, _, _ = request("GET", tampered,
                               headers={"Sec-Fetch-Site": "cross-site"}, cookie=cookie)
        self.assertEqual(status, 403)
        note = open(os.path.join(ARTICLES, "old-note.md"), encoding="utf-8").read()
        self.assertIn("read: false", note)

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


class CliResult(unittest.TestCase):
    def test_parses_the_last_object(self):
        self.assertEqual(srv.parse_cli_result('{"ok":true,"path":"/a.md"}')["path"], "/a.md")
        self.assertEqual(srv.parse_cli_result('noise\n{"ok":true}\n')["ok"], True)
        self.assertIsNone(srv.parse_cli_result("Clipped: /somewhere.md"))
        self.assertIsNone(srv.parse_cli_result('{"broken"'))
        self.assertIsNone(srv.parse_cli_result(""))


class Sessions(unittest.TestCase):
    def test_iat_and_not_before(self):
        token = srv.make_session("tester", "sekrit", 1)
        self.assertEqual(srv.read_session(token, "tester", "sekrit"), "tester")
        self.assertIsNone(srv.read_session(token, "tester", "sekrit", int(time.time()) + 60))
        self.assertEqual(srv.read_session(token, "tester", "sekrit", int(time.time()) - 60),
                         "tester")

    def test_cookie_without_iat_is_invalidated(self):
        raw = json.dumps({"u": "tester", "exp": int(time.time()) + 600},
                         separators=(",", ":")).encode()
        token = (base64.urlsafe_b64encode(raw).decode().rstrip("=") + "."
                 + srv.sign(raw, "sekrit"))
        self.assertEqual(srv.read_session(token, "tester", "sekrit"), "tester")
        self.assertIsNone(srv.read_session(token, "tester", "sekrit", 1))

    def test_sessions_after_round_trips_through_auth_file(self):
        saved = srv.load_auth()
        try:
            srv.write_auth({"user": "tester", "password_hash": "h", "secret": "s",
                            "session_days": "1", "sessions_after": "12345"})
            self.assertEqual(srv.load_auth().get("sessions_after"), "12345")
        finally:
            # This file is shared with every other test: leaving "h" as the hash
            # would break the next test that logs in.
            srv.write_auth(saved)


class RunJob(unittest.TestCase):
    """run_job against a fake CLI: the JSON contract and the path check."""

    def setUp(self):
        self.real = srv.WCLIP

    def tearDown(self):
        srv.WCLIP = self.real

    def fake(self, payload):
        path = os.path.join(TMP, "fake-wclip")
        with open(path, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nprintf '%s\\n' " + shlex.quote(payload) + "\n")
        os.chmod(path, 0o755)
        srv.WCLIP = path

    def run_job(self):
        job_id = "job-%d" % time.time_ns()
        srv.JOBS[job_id] = {"url": "https://example.com", "state": "running",
                            "t0": time.time()}
        srv.run_job(job_id, "https://example.com")
        return srv.JOBS.pop(job_id)

    def test_success(self):
        note = os.path.join(ARTICLES, "fake-note.md")
        with open(note, "w", encoding="utf-8") as f:
            f.write("---\ntitle: Fake\n---\n\ntwenty words or so here.\n")
        self.fake(json.dumps({"ok": True, "existing": False, "path": note,
                              "warnings": ["careful"]}))
        job = self.run_job()
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["stem"], "fake-note")
        self.assertFalse(job["existing"])
        self.assertEqual(job["warnings"], "warning: careful")

    def test_existing(self):
        note = os.path.join(ARTICLES, "fake-note.md")
        with open(note, "w", encoding="utf-8") as f:
            f.write("---\ntitle: Fake\n---\n\nbody\n")
        self.fake(json.dumps({"ok": True, "existing": True, "path": note}))
        job = self.run_job()
        self.assertEqual(job["state"], "done")
        self.assertTrue(job["existing"])

    def test_path_outside_articles_is_refused(self):
        self.fake(json.dumps({"ok": True, "path": "/etc/passwd"}))
        job = self.run_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("unusable path", job["error"])

    def test_error_result(self):
        self.fake(json.dumps({"ok": False, "error": "boom"}))
        job = self.run_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("boom", job["error"])

    def test_human_output_is_not_parsed(self):
        self.fake("Clipped: /home/deploy/apps/dufs/data/articles/x.md")
        job = self.run_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("no JSON result", job["error"])


class RedirectSafety(unittest.TestCase):
    def test_safe_next_rejects_control_characters(self):
        for bad in ("/articles\r\nX-Probe: yes", "/a\tb", "/a\x00b", "/a\x7fb", "/a\nb"):
            self.assertEqual(srv.safe_next(bad, "/DEF"), "/DEF", repr(bad))

    def test_login_next_never_injects_a_header(self):
        body = ("user=tester&password=%s&next=%%2Farticles%%0D%%0AX-Wclip-Probe%%3A%%20yes"
                % PASSWORD.replace(" ", "+"))
        status, headers, _ = request("POST", "/login", body)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/articles")
        self.assertNotIn("X-Wclip-Probe", headers)

    def test_toggle_back_never_injects_a_header(self):
        cookie = login()
        status, headers, _ = request(
            "GET", "/toggle?stem=%s&back=%%2Farticles%%0D%%0AZ-Wclip-Probe%%3A%%20yes" % STEM,
            cookie=cookie)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/articles")
        self.assertNotIn("Z-Wclip-Probe", headers)


class ViewContainment(unittest.TestCase):
    def test_view_refuses_a_rendition_symlinked_outside(self):
        note = os.path.join(ARTICLES, "leak.md")
        with open(note, "w", encoding="utf-8") as f:
            f.write("---\ntitle: Leak\ncreated: 2026-11-05\nread: false\n---\n\nBody.\n")
        link = os.path.join(ARTICLES, "html", "leak.html")
        os.symlink("/etc/passwd", link)
        try:
            cookie = login()
            status, _, data = request("GET", "/article/leak/view", cookie=cookie)
            self.assertEqual(status, 404)
            self.assertNotIn(b"root:", data)
        finally:
            os.unlink(link)
            os.unlink(note)


class PasswordChangeKeepsRevocation(unittest.TestCase):
    def test_cutoff_survives_a_password_change(self):
        auth = srv.load_auth()
        auth["sessions_after"] = "12345"
        srv.write_auth(auth)
        real = srv.getpass.getpass
        srv.getpass.getpass = lambda prompt="": PASSWORD
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                rc = srv.set_password_cli(["--set-user", "tester"])
        finally:
            srv.getpass.getpass = real
        self.assertEqual(rc, 0)
        self.assertEqual(srv.load_auth().get("sessions_after"), "12345")


class BoundedAdmission(unittest.TestCase):
    def test_render_queue_is_bounded(self):
        self.assertEqual(srv.RENDER_Q.maxsize, 8)

    def test_ensure_rendition_reports_a_full_queue(self):
        saved_q, saved_state = srv.RENDER_Q, srv.RENDER_STATE
        srv.RENDER_Q, srv.RENDER_STATE = queue.Queue(maxsize=2), {}
        try:
            self.assertTrue(srv.ensure_rendition("one"))
            self.assertTrue(srv.ensure_rendition("two"))
            self.assertFalse(srv.ensure_rendition("three"))
            self.assertNotIn("three", srv.RENDER_STATE)
            self.assertEqual(srv.ensure_rendition("one"), True)
        finally:
            srv.RENDER_Q, srv.RENDER_STATE = saved_q, saved_state

    def test_concurrent_password_checks_are_capped(self):
        for _ in range(4):
            srv.PASSWORD_SLOTS.acquire()
        try:
            body = "user=tester&password=%s" % PASSWORD.replace(" ", "+")
            status, _, _ = request("POST", "/login", body)
            self.assertEqual(status, 503)
        finally:
            for _ in range(4):
                srv.PASSWORD_SLOTS.release()


def main():
    try:
        unittest.main(verbosity=2, exit=False)
    finally:
        HTTPD.shutdown()
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
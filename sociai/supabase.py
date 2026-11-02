"""Minimal Supabase client for the server (standard library only).

Two calls: check a user's access token with the Auth API, and run Postgres functions
through PostgREST with the service-role key. Works with both legacy JWT keys
(anon / service_role) and the newer publishable / secret keys.
"""

import json
import urllib.error
import urllib.request


class SupabaseError(Exception):
    """Supabase didn't answer as expected. The message is for the server log only."""


class Supabase:
    def __init__(self, url, anon_key, service_key, timeout=10):
        self.url, self.anon_key, self.service_key, self.timeout = url.rstrip("/"), anon_key, service_key, timeout

    def _request(self, method, path, key, bearer=None, body=None):
        headers = {"apikey": key, "Accept": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.status, _json(res.read())
        except urllib.error.HTTPError as e:
            return e.code, _json(e.read())
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise SupabaseError(f"{method} {path}: {e}") from e

    def get_user(self, access_token):
        """The user for a valid access token, or None if Supabase rejects it."""
        status, data = self._request("GET", "/auth/v1/user", self.anon_key, bearer=access_token)
        if status == 200 and isinstance(data, dict):
            return data
        if status in (401, 403):
            return None
        raise SupabaseError(f"GET /auth/v1/user returned {status}: {data}")

    def rpc(self, fn, **args):
        """Call a Postgres function as the service role and return its JSON result."""
        # Legacy service_role keys are JWTs and go in Authorization too; new secret keys only in apikey.
        bearer = self.service_key if self.service_key.startswith("eyJ") else None
        status, data = self._request("POST", f"/rest/v1/rpc/{fn}", self.service_key, bearer=bearer, body=args)
        if status != 200:
            raise SupabaseError(f"rpc {fn} returned {status}: {data}")
        return data


def _json(raw):
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None

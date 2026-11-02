"""Minimal Supabase client for the server (standard library only).

Checks access tokens with the Auth API, runs Postgres functions through PostgREST
(as the user, with their own token, or as the service role), stores resume files in
Storage, and deletes accounts. Works with both legacy JWT keys (anon / service_role)
and the newer publishable / secret keys.
"""

import json
import urllib.error
import urllib.request


class SupabaseError(Exception):
    """Supabase didn't answer as expected. The message is for the server log only."""


class SupabaseRefused(SupabaseError):
    """The database refused a change on purpose (e.g. a per-account cap). The message is user-facing."""


class Supabase:
    def __init__(self, url, anon_key, service_key, timeout=10):
        self.url, self.anon_key, self.service_key, self.timeout = url.rstrip("/"), anon_key, service_key, timeout

    def _request(self, method, path, key, bearer=None, body=None, raw=None, extra_headers=None):
        headers = {"apikey": key, "Accept": "application/json", **(extra_headers or {})}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        data = raw
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

    @property
    def _service_bearer(self):
        # Legacy service_role keys are JWTs and go in Authorization too; new secret keys only in apikey.
        return self.service_key if self.service_key.startswith("eyJ") else None

    def rpc(self, fn, **args):
        """Call a Postgres function as the service role and return its JSON result."""
        status, data = self._request("POST", f"/rest/v1/rpc/{fn}", self.service_key, bearer=self._service_bearer, body=args)
        if status != 200:
            raise SupabaseError(f"rpc {fn} returned {status}: {data}")
        return data

    def rpc_as(self, access_token, fn, **args):
        """Call a Postgres function as the signed-in user, so row-level security applies."""
        status, data = self._request("POST", f"/rest/v1/rpc/{fn}", self.anon_key, bearer=access_token, body=args)
        if status != 200:
            raise SupabaseError(f"rpc {fn} (as user) returned {status}: {data}")
        return data

    def rows_as(self, access_token, method, table, query="", body=None):
        """Read or change a table's rows as the signed-in user, so row-level security applies.
        Returns the affected rows. A limit the database enforces (raise exception in a trigger)
        comes back as SupabaseRefused with the database's message."""
        path = f"/rest/v1/{table}" + (f"?{query}" if query else "")
        status, data = self._request(method, path, self.anon_key, bearer=access_token, body=body,
                                     extra_headers={"Prefer": "return=representation"})
        if status in (200, 201):
            return data if isinstance(data, list) else []
        if status == 400 and isinstance(data, dict) and data.get("code") == "P0001":
            raise SupabaseRefused(data.get("message") or "The database refused that change.")
        raise SupabaseError(f"{method} {table} (as user) returned {status}: {data}")

    def upload(self, access_token, bucket, path, content, content_type):
        """Store a file as the signed-in user (Storage policies apply), replacing any old one."""
        status, data = self._request("POST", f"/storage/v1/object/{bucket}/{path}", self.anon_key, bearer=access_token,
                                     raw=content, extra_headers={"Content-Type": content_type, "x-upsert": "true"})
        if status != 200:
            raise SupabaseError(f"upload {bucket}/{path} returned {status}: {data}")

    def remove(self, bucket, paths, access_token=None):
        """Delete files, as the user when a token is given, otherwise as the service role."""
        if not paths:
            return
        key, bearer = (self.anon_key, access_token) if access_token else (self.service_key, self._service_bearer)
        status, data = self._request("DELETE", f"/storage/v1/object/{bucket}", key, bearer=bearer, body={"prefixes": paths})
        if status != 200:
            raise SupabaseError(f"remove from {bucket} returned {status}: {data}")

    def list_files(self, bucket, prefix):
        """Names of the files in one folder, as the service role."""
        status, data = self._request("POST", f"/storage/v1/object/list/{bucket}", self.service_key,
                                     bearer=self._service_bearer, body={"prefix": prefix, "limit": 1000})
        if status != 200:
            raise SupabaseError(f"list {bucket}/{prefix} returned {status}: {data}")
        return [f["name"] for f in data or [] if f.get("name")]

    def delete_user(self, user_id):
        """Delete an account with the Auth admin API. Its rows go with it (on delete cascade)."""
        status, data = self._request("DELETE", f"/auth/v1/admin/users/{user_id}", self.service_key, bearer=self._service_bearer)
        if status not in (200, 204):
            raise SupabaseError(f"delete user {user_id} returned {status}: {data}")


def _json(raw):
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None

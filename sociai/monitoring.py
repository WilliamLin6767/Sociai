"""Optional error monitoring with Sentry (set SENTRY_DSN; without it nothing is sent or loaded).

Events never carry what users wrote or any secret: request bodies, cookies, local variables
and auth headers are never attached, and before_send removes any remaining field that could
hold resume text, writing samples or keys, and masks anything that looks like a key or token.
"""

import re

SENSITIVE_KEYS = {
    "resume_text", "resume", "samples", "sample", "writing_samples", "background", "sender_background",
    "body", "data", "request", "dossier", "revise", "instruction", "notes", "p_resume_text", "p_bodies",
    "p_background", "password", "authorization", "cookie", "cookies", "stripe-signature", "apikey",
    "api_key", "secret", "token", "access_token", "refresh_token",
}
# Anthropic, Stripe and Supabase keys, webhook secrets, JWTs and bearer tokens.
SECRET = re.compile(r"(sk-ant-[\w-]+|[sr]k_(?:live|test)_\w+|whsec_\w+|sb_secret_\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+)")
REMOVED = "[removed]"
_enabled = False


def scrub(value, depth=0):
    """A copy of an event (or any part of one) with sensitive fields removed and secrets masked."""
    if depth > 20:
        return REMOVED
    if isinstance(value, dict):
        return {k: (REMOVED if str(k).lower() in SENSITIVE_KEYS else scrub(v, depth + 1)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(v, depth + 1) for v in value]
    if isinstance(value, str):
        return SECRET.sub(REMOVED, value)
    return value


def before_send(event, hint):
    event.pop("request", None)  # URL, headers and body of the browser's request: not needed
    for frame_list in _frames(event):
        for frame in frame_list:
            frame.pop("vars", None)
    return scrub(event)


def _frames(event):
    for section in ("exception", "threads"):
        for item in (event.get(section) or {}).get("values") or []:
            yield ((item.get("stacktrace") or {}).get("frames")) or []


def init(dsn, environment):
    """Start Sentry if a DSN is set. Returns True when monitoring is on."""
    global _enabled
    if not dsn:
        return False
    import sentry_sdk  # only needed when monitoring is on
    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        send_default_pii=False,
        include_local_variables=False,
        max_request_body_size="never",
        traces_sample_rate=0,
        before_send=before_send,
        before_breadcrumb=lambda crumb, hint: scrub(crumb),
    )
    _enabled = True
    return True


def capture(exc):
    """Report an exception the server handled (it still goes to the log)."""
    if _enabled:
        import sentry_sdk
        sentry_sdk.capture_exception(exc)

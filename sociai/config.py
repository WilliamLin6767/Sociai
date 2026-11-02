"""Settings from the environment, plus an optional .env file for local development."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    """Load .env from the current folder, else the project root.

    Values in the file win over variables already set (override=True semantics), so a
    stale value set in Windows doesn't shadow the file. Blank values are skipped so an
    unfilled line from .env.example can't wipe a real setting. Prints names, never values.
    """
    for path in dict.fromkeys((Path.cwd() / ".env", ROOT / ".env")):
        if not path.is_file():
            continue
        values = dotenv_values(path)
        loaded = [k for k, v in values.items() if v]
        for k in loaded:
            os.environ[k] = values[k]
        print(f"Loaded {len(loaded)} setting(s) from {path}: {', '.join(loaded) or '(none)'}", flush=True)
        blank = [k for k, v in values.items() if not v]
        if blank:
            print(f"  Left blank in .env, so not loaded: {', '.join(blank)}", flush=True)
        return


def _env_int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        print(f"Ignoring {name}: not a whole number. Using {default}.", flush=True)
        return default


@dataclass
class Settings:
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_key: str = ""
    global_daily_limit: int = 100   # jobs per UTC day across everyone
    max_running: int = 2            # jobs running at once per user
    max_accounts_per_ip: int = 3    # new accounts per IP per day
    trust_proxy: bool = False       # take the client IP from X-Forwarded-For (behind Render)
    disposable_domains: set = field(default_factory=set)
    public_url: str = "http://localhost:8000"  # where Stripe sends people back to
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_pack: str = ""
    stripe_price_monthly: str = ""
    stripe_api_base: str | None = None  # tests point this at a local fake Stripe
    stripe_mode: str = "test"           # "test" or "live"; the key and events must match it
    sentry_dsn: str = ""                # optional error monitoring

    @classmethod
    def from_env(cls):
        return cls(
            supabase_url=os.environ.get("SUPABASE_URL", "").rstrip("/"),
            supabase_anon_key=os.environ.get("SUPABASE_ANON_KEY", ""),
            supabase_service_key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
            global_daily_limit=_env_int("SOCIAI_GLOBAL_DAILY_LIMIT", 100),
            trust_proxy=os.environ.get("SOCIAI_TRUST_PROXY", "") in ("1", "true", "yes"),
            disposable_domains=load_blocklist(),
            public_url=(os.environ.get("PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "http://localhost:8000").rstrip("/"),
            stripe_secret_key=os.environ.get("STRIPE_SECRET_KEY", ""),
            stripe_webhook_secret=os.environ.get("STRIPE_WEBHOOK_SECRET", ""),
            stripe_price_pack=os.environ.get("STRIPE_PRICE_PACK", ""),
            stripe_price_monthly=os.environ.get("STRIPE_PRICE_MONTHLY", ""),
            stripe_mode=(os.environ.get("SOCIAI_STRIPE_MODE") or "test").strip().lower(),
            sentry_dsn=os.environ.get("SENTRY_DSN", "").strip(),
        )

    def missing(self):
        names = {"SUPABASE_URL": self.supabase_url, "SUPABASE_ANON_KEY": self.supabase_anon_key,
                 "SUPABASE_SERVICE_ROLE_KEY": self.supabase_service_key}
        return [k for k, v in names.items() if not v]


def load_blocklist(path=Path(__file__).parent / "disposable_domains.txt"):
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    return {ln.strip().lower() for ln in lines if ln.strip() and not ln.startswith("#")}


def is_disposable(email: str, domains: set) -> bool:
    """True for addresses at a blocked domain or any subdomain of one."""
    host = email.rsplit("@", 1)[-1].strip().lower()
    parts = host.split(".")
    return any(".".join(parts[i:]) in domains for i in range(len(parts) - 1))

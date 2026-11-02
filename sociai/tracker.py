"""Outreach tracker: contacts the user enters by hand, and the follow-up rules for them.

Everything here is pure (no database, no clock), so the web server passes in "today" and the
rules can be tested directly. Rows live in public.outreach_contacts (see the migration).

  Marked sent      -> sent_at defaults to today; follow_up_at, if empty, to sent_at plus
                      FOLLOW_UP_DAYS for the role (a follow_up_at in the same request wins).
  Marked replied   -> follow_up_at is cleared; replied_at defaults to today.
  Sent, and the follow-up date has arrived -> shown as follow_up_due (the row isn't changed).
"""

import re
from datetime import date, timedelta

ROLES = ("professor", "recruiter", "alum", "other")
STATUSES = ("drafted", "sent", "replied", "no_reply", "follow_up_due", "closed")
FOLLOW_UP_DAYS = {"professor": 30, "recruiter": 7, "alum": 10, "other": 10}
TEXT_LIMITS = {"name": 200, "email": 320, "organization": 200, "subject": 300, "notes": 5000}
DATES = ("sent_at", "replied_at", "follow_up_at")
FIELDS = {*TEXT_LIMITS, "role", "status", *DATES}
WAITING = ("sent", "no_reply", "follow_up_due")  # still hoping for a reply, so follow-ups count
DUE_SOON_DAYS = 7
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Invalid(ValueError):
    """A request the user should fix. The message is user-facing."""


def parse_date(value, field="date"):
    """A YYYY-MM-DD string as a date, or None for null/empty."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not ISO_DATE.match(value):
        raise Invalid(f"{field} must be a date like 2026-11-02.")
    try:
        d = date.fromisoformat(value)
    except ValueError:
        raise Invalid(f"{field} isn't a real date.")
    if not 2000 <= d.year <= 2100:
        raise Invalid(f"{field} must be between the years 2000 and 2100.")
    return d


def clean(data: dict, partial: bool) -> dict:
    """The fields of a create (partial=False) or edit (partial=True) request, checked and trimmed.
    Dates come back as YYYY-MM-DD strings or None."""
    unknown = sorted(set(data) - FIELDS)
    if unknown:
        raise Invalid(f"Unknown field: {unknown[0]}.")
    out = {}
    for field, limit in TEXT_LIMITS.items():
        if field not in data:
            continue
        value = "" if data[field] is None else data[field]
        if not isinstance(value, str):
            raise Invalid(f"{field} must be text.")
        value = value.strip()
        if len(value) > limit:
            raise Invalid(f"{field} can be up to {limit:,} characters.")
        out[field] = value
    if ("name" in out or not partial) and not out.get("name"):
        raise Invalid("Enter the person's name.")
    if out.get("email") and not EMAIL.match(out["email"]):
        raise Invalid("That email address doesn't look right.")
    for field, allowed in (("role", ROLES), ("status", STATUSES)):
        if field in data:
            if data[field] not in allowed:
                raise Invalid(f"{field} must be one of: {', '.join(allowed)}.")
            out[field] = data[field]
    for field in DATES:
        if field in data:
            d = parse_date(data[field], field)
            out[field] = d.isoformat() if d else None
    return out


def apply_rules(old: dict | None, changes: dict, today: date) -> dict:
    """changes plus the dates a status change implies. old is the saved row (None when creating)."""
    old = old or {}
    row = {**old, **changes}
    out = dict(changes)
    status = row.get("status") or "drafted"
    was = old.get("status")
    if status == "sent" and was != "sent":
        sent = row.get("sent_at") or today.isoformat()
        out["sent_at"] = sent
        if "follow_up_at" not in changes and not row.get("follow_up_at"):
            days = FOLLOW_UP_DAYS.get(row.get("role") or "other", FOLLOW_UP_DAYS["other"])
            out["follow_up_at"] = (date.fromisoformat(sent) + timedelta(days=days)).isoformat()
    if status == "replied" and was != "replied":
        out["follow_up_at"] = None
        if not row.get("replied_at"):
            out["replied_at"] = today.isoformat()
    return out


def present(row: dict, today: date) -> dict:
    """A row as the browser gets it: shown_status (follow_up_due once a sent contact's follow-up
    date arrives) and due_in (days until the follow-up, negative when overdue; set only when it's
    due within DUE_SOON_DAYS and the contact is still waiting on a reply)."""
    out = {k: v for k, v in row.items() if k != "user_id"}
    follow = parse_date(row.get("follow_up_at")) if row.get("follow_up_at") else None
    status = row.get("status")
    out["shown_status"] = "follow_up_due" if status == "sent" and follow and follow <= today else status
    days = (follow - today).days if follow else None
    out["due_in"] = days if days is not None and status in WAITING and days <= DUE_SOON_DAYS else None
    return out


def client_today(value: str | None, server_today: date) -> date:
    """The user's local date, sent by the browser (?today=), if it's within a day of the server's
    UTC date (time zones run from UTC-12 to UTC+14). Otherwise the server's date."""
    try:
        d = parse_date(value) if value else None
    except Invalid:
        return server_today
    return d if d and abs((d - server_today).days) <= 1 else server_today

"""Stripe payments (test mode only): Checkout, the customer portal, and webhooks.

Two products, set up in the Stripe dashboard:
  pack     a one-time price for 20 credits      (STRIPE_PRICE_PACK)
  monthly  a monthly subscription, 30 credits    (STRIPE_PRICE_MONTHLY)
             added each time an invoice is paid

Credits are only ever added from signed webhooks, never from the browser coming back
from Checkout. The database adds credits for a given Stripe event id once, so a webhook
delivered twice changes nothing the second time.
"""

import json
import threading
import time
from dataclasses import dataclass

import stripe

PLANS = {
    "pack": {"credits": 20, "mode": "payment", "reason": "purchase_pack"},
    "monthly": {"credits": 30, "mode": "subscription", "reason": "subscription_credits"},
}
SUBSCRIBED = ("active", "trialing", "past_due", "unpaid")
PRICE_CACHE_SECONDS = 600
SIGNATURE_TOLERANCE = 300  # seconds; older signed events are refused (replays)


class BillingError(Exception):
    """A problem to report to the caller. status is the HTTP code; the message is user-facing."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


@dataclass
class Grant:
    """Credits a verified event says to add."""
    user_id: str | None
    customer: str | None
    credits: int
    reason: str


class Billing:
    def __init__(self, secret_key, webhook_secret, prices, public_url, api_base=None):
        self.client = stripe.StripeClient(secret_key, base_addresses={"api": api_base} if api_base else None)
        self.webhook_secret = webhook_secret
        self.prices = prices  # plan -> Stripe price id
        self.public_url = public_url.rstrip("/")
        self._price_info, self._price_time = None, 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls, s):
        """A Billing for these settings, or None (with the reason) if payments are off."""
        missing = [n for n, v in (("STRIPE_SECRET_KEY", s.stripe_secret_key), ("STRIPE_PRICE_PACK", s.stripe_price_pack),
                                  ("STRIPE_PRICE_MONTHLY", s.stripe_price_monthly)) if not v]
        if missing:
            return None, f"set {', '.join(missing)}"
        if not s.stripe_secret_key.startswith(("sk_test_", "rk_test_")):
            return None, "STRIPE_SECRET_KEY isn't a test-mode key (sk_test_...). Sociai only takes test payments for now"
        billing = cls(s.stripe_secret_key, s.stripe_webhook_secret,
                      {"pack": s.stripe_price_pack, "monthly": s.stripe_price_monthly}, s.public_url, s.stripe_api_base)
        return billing, None

    # ── Shown on the Pricing page ──

    def plans(self):
        """Credits and price for each plan, from Stripe (cached for a few minutes)."""
        with self._lock:
            if self._price_info and time.time() - self._price_time < PRICE_CACHE_SECONDS:
                return self._price_info
        info = {}
        for plan, price_id in self.prices.items():
            price = self.client.v1.prices.retrieve(price_id)
            recurring = getattr(price, "recurring", None)
            info[plan] = {"credits": PLANS[plan]["credits"], "amount": price.unit_amount, "currency": price.currency,
                          "interval": getattr(recurring, "interval", None) if recurring else None}
        with self._lock:
            self._price_info, self._price_time = info, time.time()
        return info

    # ── Checkout and the portal ──

    def create_customer(self, email, user_id):
        return self.client.v1.customers.create(params={"email": email, "metadata": {"user_id": user_id}}).id

    def has_subscription(self, customer):
        subs = self.client.v1.subscriptions.list(params={"customer": customer, "status": "all", "limit": 10})
        return any(sub.status in SUBSCRIBED for sub in subs.data)

    def checkout_url(self, user_id, customer, plan):
        params = {
            "mode": PLANS[plan]["mode"],
            "customer": customer,
            "line_items": [{"price": self.prices[plan], "quantity": 1}],
            "client_reference_id": user_id,
            "metadata": {"user_id": user_id, "kind": plan},
            # The query comes before the hash, so the app can see it under its hash routes.
            "success_url": f"{self.public_url}/?checkout=success#/account",
            "cancel_url": f"{self.public_url}/?checkout=cancelled#/pricing",
        }
        if plan == "monthly":
            params["subscription_data"] = {"metadata": {"user_id": user_id}}
        else:
            params["payment_intent_data"] = {"metadata": {"user_id": user_id, "kind": plan}}
        return self.client.v1.checkout.sessions.create(params=params).url

    def portal_url(self, customer):
        return self.client.v1.billing_portal.sessions.create(
            params={"customer": customer, "return_url": f"{self.public_url}/#/account"}).url

    # ── Webhooks ──

    def verify(self, payload: bytes, signature: str | None) -> dict:
        """The event, if the Stripe-Signature header is valid for this exact body."""
        if not self.webhook_secret:
            raise BillingError(503, "Webhooks aren't set up: STRIPE_WEBHOOK_SECRET is missing.")
        try:
            stripe.WebhookSignature.verify_header(payload, signature, self.webhook_secret, tolerance=SIGNATURE_TOLERANCE)
            return json.loads(payload)
        except (stripe.SignatureVerificationError, ValueError):
            raise BillingError(400, "Invalid signature.")

    def grant_for(self, event: dict) -> Grant | None:
        """What a verified event means for credits, or None if it doesn't add any."""
        if event.get("livemode"):
            return None  # test mode only
        obj = (event.get("data") or {}).get("object") or {}
        kind = event.get("type")
        if kind in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
            meta = obj.get("metadata") or {}
            if obj.get("mode") != "payment" or obj.get("payment_status") != "paid" or meta.get("kind") != "pack":
                return None  # subscriptions are credited from invoice.paid, including the first month
            return Grant(obj.get("client_reference_id") or meta.get("user_id"), obj.get("customer"),
                         PLANS["pack"]["credits"], PLANS["pack"]["reason"])
        if kind == "invoice.paid":
            if obj.get("status") != "paid" or self.prices["monthly"] not in _invoice_prices(obj):
                return None
            # Newer API versions keep subscription details under parent; older ones on the invoice.
            details = (obj.get("parent") or {}).get("subscription_details") or obj.get("subscription_details") or {}
            return Grant((details.get("metadata") or {}).get("user_id"), obj.get("customer"),
                         PLANS["monthly"]["credits"], PLANS["monthly"]["reason"])
        return None


def _invoice_prices(invoice):
    prices = set()
    for line in (invoice.get("lines") or {}).get("data") or []:
        new = ((line.get("pricing") or {}).get("price_details") or {}).get("price")
        old = line.get("price")
        for p in (new, old):
            if isinstance(p, dict):
                p = p.get("id")
            if p:
                prices.add(p)
    return prices

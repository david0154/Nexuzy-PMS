# Nexuzy PMS P0 hardening — implementation checklist

- [ ] Replace hard-coded JWT fallback with mandatory secret configuration and safe startup validation.
- [ ] Replace wildcard CORS with configurable allowlist and same-origin defaults.
- [ ] Enforce property scoping on every resource access and update.
- [ ] Replace client-controlled checkout override with server-side permission/policy check and mandatory reason/audit event.
- [ ] Enforce folio existence, same-property ownership, open status, positive finite amounts and allowed payment methods.
- [ ] Add idempotency keys for payments, room posting, invoices, orders and stock transactions.
- [ ] Reject payment over-collection unless an explicit deposit/credit workflow supports it.
- [ ] Enforce folio open state on charges; validate quantity/unit price/tax and use reversal/adjustment model.
- [ ] Generate advance receipts separately from final invoices; make invoice numbering collision-safe and invoice creation idempotent.
- [ ] Build reviewed checkout preview from ledger, separately settled restaurant bills, room-posted charges, advances, payments, taxes and credits.
- [ ] Prevent checkout until preview is confirmed and settlement policy passes.
- [ ] Enable LAN only after explicit admin opt-in; show host LAN URL and port, limit to private interfaces and document HTTPS/certificate setup.
- [ ] Add payment/checkout threat and regression tests; run tests in isolated disposable DB only.
- [ ] Remove test fixtures and any real backup/customer data from public source control; verify ignore and package rules.

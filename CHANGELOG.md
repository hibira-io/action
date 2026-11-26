# Changelog

## 1.1.0

- `approval-id`: wait for a request an earlier step opened with `wait: false`, so the approver can answer while the build runs.
- README: deploy notifications.
- The `url` output keeps the answer link after waiting (status answers leave it out).
- Requests that never reached Hibira (502, 503, 504, 52x from the edge) are sent again, up to twice.

## 1.0.0

- First release: `approval` (deploy gate on a person's answer, with push to their phone), `event` (realtime events), `push` (push notifications) and `waiting-room` (open, pause, close, admit).

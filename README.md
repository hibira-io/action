# Hibira for GitHub Actions

Use [Hibira](https://hibira.io) from a workflow:

- **`approval`**: stop a deploy until a person approves it. They get a link (and a push notification if you like), answer on their phone, and the job carries on or fails. It works in public and private repositories on every GitHub plan, and the approver doesn't need a GitHub account.
- **`event`**: publish a realtime event, such as deploy status for a live dashboard. Hibira speaks the Pusher Channels protocol, so any Pusher client receives it.
- **`push`**: send a push notification to your app's web, iOS or Android users.
- **`waiting-room`**: open, pause or close a waiting room and let visitors in, for a launch or ticket drop on a schedule.

## Deploy approval

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: hibira-io/action@v1
        with:
          command: approval
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          title: Deploy ${{ github.ref_name }} to production?
          timeout-minutes: 30
      - run: ./deploy.sh
```

The step prints the answer link in the log and the job summary, then waits. **Approve** lets the job continue; **Reject**, or no answer before `timeout-minutes`, fails the step. The approver sees the repository, ref, commit, who started the run and a link to it, unless you pass your own `details`.

Copy the app ID, key and secret from your app's page in the [Hibira portal](https://hibira.io/portal). Store the secret as a repository or organization secret.

More options:

```yaml
      - id: ask
        uses: hibira-io/action@v1
        with:
          command: approval
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          title: Run the database migration on production?
          details: ${{ github.event.head_commit.message }}
          options: |
            Run it
            Not now
          approvers: lead@example.com, dba        # Approvals workspace apps: emails or group slugs
          quorum: 2
          push-interests: oncall                  # also notify your app's "oncall" push subscribers
          fail-on-reject: false
      - if: steps.ask.outputs.status == 'approved'
        run: ./migrate.sh
      - if: steps.ask.outputs.status != 'approved'
        run: echo "Skipped: ${{ steps.ask.outputs.comment }}"
```

The runner stays busy while it waits, so keep `timeout-minutes` close to how long an answer should take, and set the job's own `timeout-minutes` above it. If the approver asks a question instead of deciding, it shows in the log; answer it on the approval page.

| Input | |
| --- | --- |
| `title` | The question (required). |
| `details` | Context for the approver. Defaults to the run's repository, workflow, ref, commit, actor and link. |
| `options` | Answers, one per line or comma-separated. The first one approves. Default `Approve`, `Reject`. |
| `timeout-minutes` | How long to wait, 1 to 10080. Default 60. |
| `fail-on-reject` | Fail the step when not approved. Default `true`. |
| `wait` | `false` opens the request, outputs its link and moves on. Default `true`. |
| `approval-id` | Wait for a request an earlier step opened with `wait: false`, instead of opening a new one. |
| `approvers`, `quorum` | Who must answer and how many approvals are needed (apps in an Approvals workspace). |
| `push-interests`, `push-users` | Send a push notification about the request through your app's push instance. |
| `channel` | A channel that gets an `approval` event on request and decision. |

Ask early, wait later: open the request at the start of the job so the approver can answer while the build runs, then wait for it right before the deploy.

```yaml
      - id: ask
        uses: hibira-io/action@v1
        with:
          command: approval
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          title: Deploy ${{ github.ref_name }} to production?
          wait: false
      - run: npm ci && npm run build
      - uses: hibira-io/action@v1
        with:
          command: approval
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          approval-id: ${{ steps.ask.outputs.approval-id }}
      - run: ./deploy.sh
```

Outputs: `approval-id`, `url`, `status` (`approved`, `rejected`, `expired` or `pending`), `choice`, `comment`, `answered-by`.

## Deploy notifications

Put a step at the end of the deploy job with `if: always()`, so it runs whether the deploy passed or failed. Send an event for a live dashboard or status page, a push notification for your app's users, or both:

```yaml
      - if: always()
        uses: hibira-io/action@v1
        with:
          command: event
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          channel: deploys
          event: deploy.finished
          data: '{"repo":"${{ github.repository }}","version":"${{ github.ref_name }}","status":"${{ job.status }}","run":"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
      - if: success()
        uses: hibira-io/action@v1
        with:
          command: push
          instance-id: ${{ vars.HIBIRA_PUSH_INSTANCE_ID }}
          push-secret-key: ${{ secrets.HIBIRA_PUSH_SECRET_KEY }}
          push-interests: release-notes
          title: Version ${{ github.ref_name }} is live
```

A browser on the dashboard receives it with any Pusher client:

```js
pusher.subscribe('deploys').bind('deploy.finished', (d) => showDeploy(d));
```

## Realtime event

```yaml
      - uses: hibira-io/action@v1
        with:
          command: event
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          channel: deploys
          event: deploy.finished
          data: '{"version":"${{ github.ref_name }}","status":"${{ job.status }}"}'
```

`channel` takes up to 100 channels, one per line or comma-separated. `data` that is valid JSON is sent as is; anything else is sent as a JSON string.

## Push notification

```yaml
      - uses: hibira-io/action@v1
        with:
          command: push
          instance-id: ${{ vars.HIBIRA_PUSH_INSTANCE_ID }}
          push-secret-key: ${{ secrets.HIBIRA_PUSH_SECRET_KEY }}
          push-interests: release-notes
          title: Version ${{ github.ref_name }} is out
          body: See what's new.
          url: https://example.com/changelog
```

Give `push-interests` or `push-users` (not both). `send-at` (RFC 3339, up to 30 days ahead) schedules it. The instance ID and secret key are on your app page under Push notifications. Output: `publish-id`.

## Waiting room

```yaml
on:
  schedule:
    - cron: '0 1 * * 5'   # Fridays 01:00 UTC
jobs:
  open:
    runs-on: ubuntu-latest
    steps:
      - uses: hibira-io/action@v1
        with:
          command: waiting-room
          app-id: ${{ vars.HIBIRA_APP_ID }}
          key: ${{ vars.HIBIRA_APP_KEY }}
          secret: ${{ secrets.HIBIRA_APP_SECRET }}
          room: friday-drop
          state: open
          admit-per-minute: 200
```

Inputs: `room` (required), `state` (`open`, `paused` or `closed`), `admit` (let this many more in now), `admit-per-minute`, `starts-at`, `title`, `notice`. Outputs: `status`, `waiting`, `admitted`.

## Host

Every command takes `host`, the API host shown on your app page. The default is `https://ws.hibira.io`.

## Development

No dependencies and no build step: `npm test` runs the tests with Node's built-in runner. Releases are `v1.x.y` tags; the release workflow moves `v1` to the newest one.

## 中文摘要

`hibira-io/action` 讓 GitHub Actions workflow 直接使用 Hibira：

- `approval`：部署前請人核准。也可以在 job 開始時先發出請求（`wait: false`），建置完成後再用 `approval-id` 等待結果。審核者收到連結（可加推播），在手機上按核准後 job 才繼續；拒絕或逾時則 step 失敗。公開與私有 repo、任何 GitHub 方案都能用，審核者不需要 GitHub 帳號。
- `event`：發送即時事件（例如把部署狀態推到儀表板），任何 Pusher client 都收得到。部署通知：在 job 最後加一個 `if: always()` 的 step，不論成功或失敗都會送出。
- `push`：發送推播通知給你 app 的 Web、iOS、Android 使用者。
- `waiting-room`：開啟、暫停、關閉排隊室或放人，可配合排程在發售時自動執行。

app ID、key、secret 在 Hibira 主控台的 app 頁面；secret 請存成 repository secret。沒有任何相依套件，`npm test` 執行測試。

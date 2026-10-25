# Skills sync webhook

[`.amp/plugins/skills-sync.ts`](../.amp/plugins/skills-sync.ts) mirrors `skills/**` from `Hopsken/pi-suite@main` into the
Amp personal skills repository (`amp clone user-skills`) whenever GitHub delivers a push webhook.

## Behaviour

- The plugin registers one durable webhook under the key `skills-sync`. Every thread of this project reuses the same URL.
  Without `PI_SUITE_SKILLS_WEBHOOK_SECRET` in the environment it registers nothing and logs one line.
- A delivery is processed only when it carries a valid `x-hub-signature-256`, `x-github-event: push`, a `refs/heads/main`
  ref, and the `Hopsken/pi-suite` repository. Branch deletions and non-push events are ignored.
- Only pushes that touch `skills/<name>/**` are synchronized. When GitHub truncates the commit list, every skill is
  reconciled instead of guessing.
- Each sync takes a fresh shallow snapshot of `main` and copies the affected skill directories into a clone of the personal
  skills repository, then commits and pushes. A skill removed upstream is removed from the personal skills repository when
  this plugin synced it before.
- Delivery is at least once: recent delivery IDs are recorded and replayed deliveries are skipped. Content is compared
  before committing, so a repeated or concurrent delivery never produces a second commit.
- The mirror owns every skill whose name matches a directory in `skills/`. A personal skill with a colliding name is
  replaced on sync and removed when the matching source skill is deleted.

## State

Everything lives in `~/.cache/pi-suite-skills-sync/`:

| Path              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `webhook-url`     | Capability URL of the registration, written on each plugin load, mode 0600. Treat it as a credential. |
| `state.json`      | Recent delivery IDs and the set of skills this mirror owns.    |
| `source/`         | Shallow clone of `Hopsken/pi-suite` used as the content source. |
| `personal-skills/`| Clone of the personal skills repository that is committed and pushed. |

Deleting the cache is safe. The next delivery rebuilds both clones, treats the push as the only affected set, and
re-syncs; the registration keeps the same URL, and the next plugin load rewrites `webhook-url`.

## Setup

1. Store the webhook secret as the `PI_SUITE_SKILLS_WEBHOOK_SECRET` project secret:

   ```bash
   cd /path/to/pi-suite
   openssl rand -hex 32 | amp secrets set PI_SUITE_SKILLS_WEBHOOK_SECRET --secret --data-file - --project
   ```

2. Create a GitHub webhook on `Hopsken/pi-suite` with the URL printed at `~/.cache/pi-suite-skills-sync/webhook-url`,
   content type `application/json`, the same secret, SSL verification on, and only the `push` event.

3. Make the secret and the registration visible to the plugin, then reload it:

   ```bash
   amp orb restart-processes
   ```

   Reload the plugin from the command palette (`plugins: reload`) or open a new thread. The log then shows
   `Skills sync webhook is ready for Hopsken/pi-suite main pushes`.

The webhook URL only works while its owning thread is unarchived. Archiving that thread makes the URL return 404 and
pauses delivery until the thread is restored.

## Verifying a delivery by hand

```bash
url="$(cat ~/.cache/pi-suite-skills-sync/webhook-url)"
secret="<the value you stored as PI_SUITE_SKILLS_WEBHOOK_SECRET>"
payload=/tmp/push.json

curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$url" \
  -H 'content-type: application/json' \
  -H 'x-github-event: push' \
  -H 'x-github-delivery: manual-1' \
  -H "x-hub-signature-256: sha256=$(openssl dgst -sha256 -hmac "$secret" -binary < "$payload" | xxd -p -c 256)" \
  --data-binary @"$payload"
```

Then check the result:

```bash
jq -r 'select(.message=="Plugin stderr") | .stderr' ~/.cache/amp/logs/headless.log | tail -3
git -C ~/.cache/pi-suite-skills-sync/personal-skills log --oneline -3
gh api repos/Hopsken/pi-suite/hooks --jq '.[].id'   # pick the hook, then:
gh api repos/Hopsken/pi-suite/hooks/<id>/deliveries --jq '.[0] | {event, status, status_code}'
```

## Rotating the secret

Update the project secret and the GitHub webhook secret to the same value, run `amp orb restart-processes`, and reload the
plugin. Deliveries signed with the old secret are ignored with `Ignored a delivery with a missing or invalid signature`
until the plugin sees the new one.

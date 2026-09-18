# Reference hosted stack

This directory is the copyable, sanitized companion to
[`docs/reference-stack.md`](../../docs/reference-stack.md). It models the reviewed
topology: Neon PostgreSQL, a Next.js deployment on Vercel, separate owner/worker/
scheduler credentials, the packaged Hermes worker adapter, a restricted Hermes
profile, and a script-only fifteen-minute clock.

Start with a write-free validation:

```sh
python3 examples/reference-stack/render.py \
  --config examples/reference-stack/stack.example.json
```

Copy `stack.example.json`, replace the synthetic locations and runtime choices,
create the referenced secret files with mode `0600`, then render into a new
owner-only directory:

```sh
umask 077
python3 examples/reference-stack/render.py \
  --config /protected/job-seeker/stack.json \
  --write --output /protected/job-seeker/generated
python3 examples/reference-stack/render.py \
  --check-generated /protected/job-seeker/generated
```

The renderer never prints secret contents. Dry-run is the default and does not
read secret files. The native job is generated disabled.

The generated clock performs one scheduler tick and drains runnable work until
the queue is empty or the configured claim deadline is reached. It reads only
owner-only files and exits before Hermes starts when the queue is empty. Install
the generated systemd unit and timer for the portable path. The disabled native
job is the equivalent shape for the reviewed Hermes release.

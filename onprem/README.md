# onprem — appliance packaging

One artifact, two profiles (spec §14): docker-compose appliance (kernel, plugin-runner, PostgreSQL, PgBouncer, Valkey, S3, nginx) and SaaS from the same image.

P0 contains no compose file yet — it lands with the kernel skeleton in P1. Install/upgrade instructions here are validated by fresh-VM drills (an agent following the docs verbatim must succeed).

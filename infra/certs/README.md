# Supabase database trust anchor

`prod-ca-2021.crt` is a **public CA certificate**, not a key or credential. Downloaded
from the production URL specified by [Supabase Studio's configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json):

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Subject/issuer: `Supabase Root 2021 CA`. Expires 2031-04-26.
SHA-256 certificate fingerprint:
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.

The current API Dockerfile copies this into `/app/infra/certs/`; owner migrations
rewrite that path in memory for the local checkout. Require Prisma 6
`sslmode=require`, `sslaccept=strict`, and `sslcert` pointing at this certificate.
Check the actual project's Database Settings CA fingerprint before deployment.
A mismatch requires a reviewed CA update and rebuilt API image; never relax TLS.

This inspection does not prove a successful live Supavisor handshake. The owner
must evidence migration/API connectivity with strict TLS and a failed connection
using an incorrect CA before accepting the target environment.

References: [Prisma 6 TLS options](https://docs.prisma.io/docs/orm/v6/overview/databases/postgresql),
[Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).

# GCS-SSC Amazon S3 Storage Provider

Private Amazon S3 object-storage provider for GCS-SSC. The host owns attachment metadata, authorization, target lifecycle, and all upload/download APIs. This extension supplies server-side put/get/delete operations and an agency configuration panel.

Configuration supports bucket, AWS region, an optional key prefix, Node's default credential provider chain or agency-scoped encrypted access keys, and bucket-default encryption or SSE-KMS. It deliberately does not support custom endpoints, S3-compatible services, presigned browser transfers, or custom attachment metadata. Explicit credentials are stored through the host encrypted extension-secret store and browser responses expose only a masked access-key identifier.

The connection test writes, reads, verifies, and deletes a random canary object.

Run `bun run typecheck`, `bun run test:unit`, and `bun run test:coverage`. A real AWS test is opt-in with `GCS_S3_REAL_CANARY=true`, `GCS_S3_CANARY_BUCKET`, and `AWS_REGION`, then `bun run test:canary:s3`.


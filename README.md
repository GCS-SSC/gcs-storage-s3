# GCS-SSC S3-Compatible Storage Provider

Private Amazon S3 and Backblaze B2 object-storage provider for GCS-SSC. The host owns attachment metadata, authorization, target lifecycle, and all upload/download APIs. This extension supplies server-side put/get/delete operations and an agency configuration panel.

Amazon S3 configuration supports bucket, AWS region, an optional key prefix, Node's default credential provider chain or agency-scoped encrypted access keys, and bucket-default encryption or SSE-KMS. Backblaze B2 configuration supports the bucket's official S3 endpoint, an optional key prefix, bucket-default encryption, and a bucket-scoped application key stored as an agency encrypted secret. The endpoint is restricted to HTTPS `s3.<region>.backblazeb2.com` hosts; arbitrary S3-compatible endpoints are not accepted because an application-entered endpoint would create an SSRF and credential-exfiltration boundary that URL validation alone cannot secure.

B2 uses path-style bucket addressing and derives its signing region from the validated endpoint. New locators pin the service, bucket, region, endpoint, addressing mode, and provider-returned object version ID. Deletes target that exact version so versioned AWS buckets and always-versioned B2 buckets do not retain billable hidden object versions. Legacy locators without a version ID retain key-only deletion behavior.

The backend fingerprint cannot change while active attachments reference the provider; credential rotation and key-prefix changes remain available. Encrypted credential payloads are tagged with their service, and legacy untagged credentials are treated as Amazon S3 credentials only. Browser responses expose only a masked access-key identifier. Presigned browser transfers and custom attachment metadata are not supported.

Writes use a single SDK attempt because retrying an ambiguously completed PUT can create multiple billable versions under one key. Each write carries a random metadata token; on an ambiguous failure the adapter performs a best-effort HEAD and exact-version delete only when that token proves the recovered version belongs to the failed write. A later host/application retry receives a new opaque key. Version-specific reads and deletes retain the SDK's bounded standard retry behavior. The 10 MiB host upload cap deliberately uses one `PutObject`; multipart upload would add requests and orphan-part risk without a size benefit.

Saving replacement agency credentials first writes, reads, verifies, and deletes a random canary object inside the authorized transaction, so a bad rotation cannot overwrite the last working secret. The explicit connection test runs the same three-request canary on demand.

Run `bun run typecheck`, `bun run test:unit`, and `bun run test:coverage`. A real AWS test is opt-in with `GCS_S3_REAL_CANARY=true`, `GCS_S3_CANARY_BUCKET`, and `AWS_REGION`, then `bun run test:canary:s3`.

For a real Backblaze test, create the ignored, mode-`0600` `.env.b2.local` containing `B2_S3_BUCKET`, `B2_S3_ENDPOINT`, `B2_S3_KEY_ID`, and `B2_S3_APPLICATION_KEY`, then run `bun run test:canary:b2`. Use a bucket-restricted application key rather than the unsupported B2 master application key.

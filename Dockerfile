# package.json pins the SDK to the maintainer's preview build (pkg.pr.new @cloudflare/sandbox@799,
# from PR #799) which carries the RPC robustness + tracing fixes. That build runs against the
# 0.12.2 base image, matching how the maintainer reproduced it.
FROM docker.io/cloudflare/sandbox:0.12.2

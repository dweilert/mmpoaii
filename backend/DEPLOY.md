# MMPOA Backend — Deploy Guide

## Existing Infrastructure

`existing-infrastructure.yaml` documents all AWS resources that were originally created
via the AWS Console. It is checked into git as a reference and for disaster recovery.
The Lambda source code lives in `existing-lambdas/`.

**Do NOT deploy `existing-infrastructure.yaml`** — it would create duplicate resources.
It exists so the full AWS setup is version-controlled alongside the site code.

| Existing Resource | ID / Name |
|-------------------|-----------|
| Cognito User Pool | `us-east-1_tfk0ub8lC` (`mmpoaii-hoa-users`) |
| Cognito Client | `787l9oam57h8nv74i5gdf7i6b` (`mmpoaii-web-client-v2`) |
| Cognito Groups | `board` (precedence 1), `homeowners` (precedence 2) |
| HTTP API (v2) | `vbttai9kma` — document upload (`POST /upload-url`, `DELETE /delete`) |
| REST API | `604iprtdt1` — financial reports (`GET /financial/account-balance`) |
| Lambda | `hoa-document-upload` — presigned S3 URL generator |
| Lambda | `mmpoaii-account-balance-report` — fetches PDF from Google Drive CSV |
| S3 Bucket | `hoa-documents-mmpoaii` — meeting minutes, budgets |

---

# Review System — Deploy Guide

## Prerequisites

1. **AWS CLI** configured with credentials (`aws sts get-caller-identity` should work)
2. **AWS SAM CLI** installed (`brew install aws-sam-cli` on macOS)
3. **Node.js 20+** installed (for `sam build`)

## One-time setup

### 1. Create the seed S3 bucket (optional — only needed for S3-based seeding)

```bash
aws s3 mb s3://mmpoa-review-seeds --region us-east-1
```

## Deploy

```bash
cd backend
sam build
sam deploy
```

SAM will show you a changeset of all resources being created. Type `y` to confirm.

## What gets created

| Resource | Name | Purpose |
|----------|------|---------|
| DynamoDB Table | `mmpoa-reviews` | Single-table for all review data |
| Cognito Group | `reviewers` | Document review committee |
| Cognito Group | `review-admins` | Review administrators |
| API Gateway | `mmpoa-review-api` | REST API with Cognito authorizer |
| Lambda x10 | `mmpoa-review-*` | One function per API route |
| IAM Roles | auto-generated | Scoped per-function (read-only or CRUD) |

## After deploy

1. The API URL is printed in the stack outputs. Copy it.
2. Add it to `js/config.js`:
   ```js
   reviewApiUrl: 'https://XXXXXXX.execute-api.us-east-1.amazonaws.com/prod',
   ```
3. Add users to the new Cognito groups:
   ```bash
   aws cognito-idp admin-add-user-to-group \
     --user-pool-id us-east-1_tfk0ub8lC \
     --username <USERNAME> \
     --group-name reviewers

   aws cognito-idp admin-add-user-to-group \
     --user-pool-id us-east-1_tfk0ub8lC \
     --username <USERNAME> \
     --group-name review-admins
   ```

## Test the API

```bash
# Get a token (replace USERNAME and PASSWORD)
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id 787l9oam57h8nv74i5gdf7i6b \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=<user>,PASSWORD=<pass> \
  --query 'AuthenticationResult.IdToken' --output text)

# List cycles
curl -H "Authorization: $TOKEN" \
  https://XXXXXXX.execute-api.us-east-1.amazonaws.com/prod/cycles
```

## Tear down

```bash
sam delete --stack-name mmpoa-review
```

This removes all Lambda functions, API Gateway, IAM roles, and Cognito groups.
The DynamoDB table has `DeletionPolicy: Retain` by default in SAM — delete manually if needed:

```bash
aws dynamodb delete-table --table-name mmpoa-reviews
```

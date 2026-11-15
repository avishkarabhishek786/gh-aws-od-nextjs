# Production-style Next.js on AWS: GitHub Actions CI, Octopus Deploy CD, ECR, ALB and ASG

Nov 15, 2026 · @Abhijeet

## What you'll build

You will create a Next.js app, put it on GitHub, and set up a pipeline so that every push to `main` builds a Docker image and stores it in Amazon ECR (GitHub Actions, the CI half), then Octopus Deploy (the CD half) rolls it out, without downtime, to Auto Scaling Group instances behind an **internal** Application Load Balancer. The whole VPC is private: no public subnets, no internet gateway, no NAT gateway and no public IP addresses. Plan on 3 to 4 hours the first time, and roughly US$0.20 per hour while the AWS resources run (approximate: the VPC interface endpoints are now the largest charge, then the ALB and the two t3.micro instances).

**How a release flows**

1. You push code to GitHub. GitHub Actions (CI) builds a container image, tags it with the commit ID and a release number such as 1.0.7, and pushes it to ECR.
2. Actions signs in to AWS, and then to Octopus Deploy, with short-lived OIDC credentials. There are no stored access keys or API keys.
3. Actions creates an Octopus release with the same release number. Octopus Deploy (CD) deploys it: it records the tag in an SSM parameter, then starts an ASG Instance Refresh and waits for it to finish.
4. The ASG launches replacement instances first and removes old ones only after the new ones are healthy.
5. Each new instance sits in a private subnet with no route to the internet. It reads the tag and pulls that image from ECR through VPC endpoints, then runs it. The ALB sends it traffic only after the health check passes.

**How the private network works**

- With no NAT or internet gateway, instances reach AWS services only through **VPC endpoints** (PrivateLink): ECR, Systems Manager and CloudWatch Logs, plus a free S3 gateway endpoint that also serves ECR image layers and the Amazon Linux package repository.
- The ALB is **internal**. It has private addresses only, so you cannot open it from your laptop's browser. You test it from inside the VPC with a Session Manager shell, and Part 7 lists ways to reach it from a browser later.
- GitHub Actions calls ECR, and Octopus Deploy calls Systems Manager and Auto Scaling. These are public AWS APIs, authenticated with short-lived credentials. Neither tool ever connects into your VPC (Part 5 shows how to keep even those calls inside it).

**What makes this production-style compared with a simple demo**

- Instances and the load balancer have no public addresses at all.
- Every release is an immutable, versioned image (one per commit, scanned on push), not a script that builds on boot.
- No long-lived credentials anywhere, and least-privilege IAM roles.
- Rolling deploys with no downtime, and a one-step rollback to any earlier release, with environments, approvals and an audit trail from Octopus Deploy.
- Logs go to CloudWatch, and you reach instances with Session Manager instead of SSH.

**Deliberate simplifications:** plain HTTP inside the VPC (you have no domain, so no certificate), and one Octopus environment (Demo). The final section lists what a real production setup adds.

&#91;embedded content: pipeline and runtime · GitHub Actions (CI) and Octopus Deploy (CD) to the ASG behind the ALB\]

The top half is the release path: a push makes GitHub Actions build one image in ECR and create a release, then Octopus Deploy records the version in the parameter and refreshes the ASG. The bottom half is the private runtime: the ALB is internal, the instances have no public address, and the dashed arrows show the instances pulling their image, reading the version and sending logs through VPC endpoints instead of the internet.

## Prerequisites and conventions

You need three accounts and a few local tools. Building an app and pushing code need a terminal, but every AWS resource is created in the AWS console. The only AWS commands are the ones the pipeline runs for you: GitHub Actions for CI and Octopus Deploy for CD.

- **AWS account:** use an IAM user or role with admin-like rights in a sandbox account, not the root user. Set a budget alert first (Billing and Cost Management → Budgets).
- **GitHub account** with permission to create a repository.
- **Octopus Deploy account:** Octopus Cloud (a free trial is enough) or a self-hosted Octopus Server. A self-hosted server must be version 2024.1 or later, because OIDC sign-in to AWS needs it.
- **Local tools:** Node.js 22 (LTS) with npm, Git, and Docker Desktop or Docker Engine. Docker is optional but recommended so you can test the image before AWS ever sees it.
- **Region:** switch the console to **Asia Pacific (Mumbai) ap-south-1** and keep it there for every part.

| Part | What you do | Where |
| --- | --- | --- |
| 1. Next.js app | Create and edit the app | Local terminal and editor |
| 2. Container | Write a Dockerfile, test locally | Local terminal |
| 3. GitHub | Create a repo, push the code | GitHub web UI and terminal |
| 4. AWS foundations | Private VPC, endpoints, security groups, ECR, IAM, log group, parameter | AWS console |
| 5. Pipeline (CI and CD) | GitHub workflow for CI, Octopus project for CD | Editor, GitHub web UI and Octopus web UI |
| 6. Runtime | Launch template, target group, internal ALB, ASG | AWS console |
| 7. Operate | Test, deploy a change, roll back, scale | Session Manager shell, console, Git |
| 8. Cleanup | Delete everything | AWS console, GitHub web UI and Octopus web UI |

**Conventions used below.** Every AWS resource is named with the prefix `nextjs-alb-demo` and tagged `Project` = `nextjs-alb-demo` where the console offers tags. The GitHub repository is called `acme-status`. Replace `ACCOUNT_ID` with your 12-digit AWS account ID (click your name at the top right of the console to see it) and `GITHUB_OWNER` with your GitHub username or organization.

Console screens change over time. If a label differs slightly from this text, pick the closest match.

## Part 1: Create the Next.js app

Generate a fresh app, then replace a few files. The app shows which instance served the request and which version is running, so you can watch rollouts later.

```bash
npx create-next-app@latest acme-status --js --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-npm
cd acme-status
rm -f app/globals.css app/page.module.css
```

If the generator asks anything else, accept the default (for example, decline the React Compiler). Now create or replace these files.

**`next.config.mjs`** (if your project has `next.config.js` instead, use `module.exports = { output: 'standalone' };`). The `standalone` output makes the build produce a small self-contained server, which keeps the Docker image lean.

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
};

export default nextConfig;
```

Make sure this is the **only** Next.js config file. If the generator also created `next.config.ts`, delete it. Keep `cacheComponents` **off**: newer Next.js versions can enable it, and it rejects the `export const dynamic = 'force-dynamic'` lines used in the files below (the error reads "Route segment config "dynamic" is not compatible with `nextConfig.cacheComponents`"). If you see that error, remove `cacheComponents` (and partialPrefetching, if present) from your config, or simply replace the whole file with the block above, and restart `npm run dev`.

**`app/layout.js`**

```js
export const metadata = { title: 'Acme Status' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

**`app/page.js`** shows the instance ID and Availability Zone from the EC2 metadata service (IMDSv2), and the version baked into the image. Off EC2 it falls back to a friendly message.

```js
export const dynamic = 'force-dynamic';

// On EC2 we read the instance ID and zone from the metadata service (IMDSv2).
async function meta(path) {
  try {
    const token = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.text());
    return await fetch('http://169.254.169.254/latest/meta-data/' + path, {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.text());
  } catch {
    return 'not running on EC2';
  }
}

export default async function Home() {
  const id = await meta('instance-id');
  const az = await meta('placement/availability-zone');
  const version = (process.env.APP_VERSION || 'dev').slice(0, 7);
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 40 }}>
      <h1>Acme Status</h1>
      <p>Version: <b>{version}</b></p>
      <p>Served by instance: <b>{id}</b></p>
      <p>Availability Zone: <b>{az}</b></p>
    </main>
  );
}
```

**`app/api/health/route.js`** is what the ALB and Docker use to check the app is alive.

```js
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ status: 'ok' });
}
```

**`app/api/burn/route.js`** spins the CPU for 300 ms, to trigger scaling later.

```js
export const dynamic = 'force-dynamic';

export async function GET() {
  const end = Date.now() + 300;
  while (Date.now() < end) {
    Math.sqrt(Math.random());
  }
  return Response.json({ burned: '300ms' });
}
```

Try it: run `npm run dev` and open `http://localhost:3000`. You should see the page with "not running on EC2", and `http://localhost:3000/api/health` should return `{"status":"ok"}`. Stop the dev server with Ctrl+C. Keep `package-lock.json`; the Docker build needs it.

## Part 2: Put the app in a container image

The image is the release artifact: built once in CI, identical on every instance. This Dockerfile uses three stages so the final image holds only what the server needs, and it runs as a non-root user.

Create **`Dockerfile`** in the project root:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=$APP_VERSION
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
```

Create **`.dockerignore`** so local junk and secrets never enter the build:

```text
node_modules
.next
.git
.github
.env*
Dockerfile
.dockerignore
README.md
```

Build and run it locally to prove it works before any cloud is involved:

```bash
docker build --build-arg APP_VERSION=abc1234 -t acme-status:local .
docker run --rm -p 3000:3000 acme-status:local
```

Open `http://localhost:3000`. You should see **Version: abc1234**, and `http://localhost:3000/api/health` returns `{"status":"ok"}`. Stop it with Ctrl+C.

One detail for later: the instances (t3) are x86-64, and GitHub's `ubuntu-latest` runners are x86-64 too, so the image the pipeline builds will run there. If you ever switch to Graviton (t4g) instances, build an arm64 image instead.

## Part 3: Push the code to GitHub

1. In the GitHub web UI, choose **+ → New repository**. Name it `acme-status`, pick **Private**, and leave **Add a README**, **.gitignore** and **license** all unticked (your project already has its own). Choose **Create repository**.
2. From your project folder, commit and push. `create-next-app` already ran `git init` and made a first commit, so you only add the new files:

```bash
git add -A
git commit -m "Add demo app and Dockerfile"
git branch -M main
git remote add origin https://github.com/GITHUB_OWNER/acme-status.git
git push -u origin main
```

3. Reload the repository page and confirm you can see `Dockerfile`, `app/` and `package-lock.json`. There should be no `node_modules` or `.next` folder; the generated `.gitignore` keeps them out.

If the push asks for a password, GitHub no longer accepts account passwords over HTTPS. Sign in through Git Credential Manager or GitHub Desktop, use a personal access token, or switch the remote to the SSH URL.

**Protect `main` later.** Because every push to `main` will deploy to AWS, a real team protects it (Settings → Rules → Rulesets → New branch ruleset, target `main`, require a pull request). Do that after Part 7, otherwise each test change below would need its own pull request.

## Part 4: Build the AWS foundations in the console

Everything the pipeline and the instances depend on gets created first. Check the region (Mumbai) before each step.

### 4.1 Network: a VPC with only private subnets

Open **VPC → Your VPCs → Create VPC** and choose **VPC and more**.

1. **Name tag auto-generation:** keep it ticked and enter `nextjs-alb-demo`. **IPv4 CIDR block:** `10.0.0.0/16`. No IPv6.
2. **Number of Availability Zones:** 2. **Public subnets:** **0**. **Private subnets:** **2**.
3. **NAT gateways:** **None**. With no public subnets the wizard also creates no internet gateway. That is the property that keeps everything private.
4. **VPC endpoints:** **S3 Gateway**. It is free, and the instances need it at boot: ECR image layers come from S3, and so does the Amazon Linux package repository that installs Docker.
5. **DNS options:** tick both **Enable DNS hostnames** and **Enable DNS resolution**. The interface endpoints in 4.3 depend on them.
6. Choose **Create VPC**. When it finishes, open the VPC's **Resource map** and confirm it shows two private subnets, no internet gateway and no NAT gateway.

### 4.2 Security groups

In **EC2 → Network & Security → Security Groups**, create three groups, all with **VPC** set to `nextjs-alb-demo-vpc`:

1. `nextjs-alb-demo-alb-sg`: inbound rule HTTP (80) from **Custom** source `10.0.0.0/16`, the VPC's own address range. Do not use Anywhere; nothing outside the VPC can reach this ALB anyway, and this keeps the rule honest.
2. `nextjs-alb-demo-ec2-sg`: inbound rule **Custom TCP**, port `3000`, source `nextjs-alb-demo-alb-sg` (pick it from the list). Leave outbound as the default.
3. `nextjs-alb-demo-endpoints-sg`: inbound rule **HTTPS** (443), source `nextjs-alb-demo-ec2-sg`. This lets instances talk to the VPC endpoints and nothing else.

There is no SSH rule and no rule open to the internet.

**Why three groups?** A security group is a stateful firewall attached to a network interface, and a rule can name another security group as its source. Giving each tier its own group lets each rule say exactly who may talk to whom, instead of opening address ranges:

- **`alb-sg` guards the front door.** It decides who may send requests to the load balancer. Here that is anything inside the VPC (`10.0.0.0/16`), including your test client. In a public setup this is the group that would face the internet.
- **`ec2-sg` guards the app.** It allows port 3000 only from `alb-sg`, so the only way to reach a container is through the load balancer. Even another instance in the VPC cannot connect to it directly. Scaled-out and replacement instances join this group automatically through the launch template, so the rule keeps working as the fleet changes.
- **`endpoints-sg` guards the AWS service endpoints.** The interface endpoints from 4.3 are network interfaces in your subnets, and they need a group too. It allows HTTPS (443) only from `ec2-sg`, so the instances can reach ECR, Systems Manager and CloudWatch Logs, and nothing else in the VPC can use those endpoints.

The chain is: client → `alb-sg` → ALB → `ec2-sg` → container, and instance → `endpoints-sg` → AWS services. Referencing groups instead of IP addresses means nothing breaks when instances are replaced and get new addresses. It is also why Part 8 deletes them in a fixed order: each group is referenced by the next.

### 4.3 Interface endpoints: the instances' only way to AWS

Without a NAT gateway, each AWS service the instances call needs its own **interface endpoint**, a private network interface in your subnets that the service's normal DNS name resolves to. Open **VPC → Endpoints → Create endpoint** and repeat the steps below once per row:

| Service name | What the instances use it for |
| --- | --- |
| `com.amazonaws.ap-south-1.ecr.api` | Logging in to ECR |
| `com.amazonaws.ap-south-1.ecr.dkr` | Pulling the Docker image |
| `com.amazonaws.ap-south-1.ssm` | Reading the version parameter, and Session Manager |
| `com.amazonaws.ap-south-1.ssmmessages` | Session Manager sessions |
| `com.amazonaws.ap-south-1.ec2messages` | Systems Manager agent messaging |
| `com.amazonaws.ap-south-1.logs` | Sending container logs to CloudWatch |

1. **Name:** `nextjs-alb-demo-` plus the short name (for example `nextjs-alb-demo``-ecr-api`). **Type:** **AWS services**, then search for and select the service name from the table.
2. **VPC:** `nextjs-alb-demo-vpc`. Under **Additional settings**, make sure **Enable DNS name** is ticked.
3. **Subnets:** tick both Availability Zones and choose the private subnet in each.
4. **Security groups:** remove `default` and select `nextjs-alb-demo-endpoints-sg`. **Policy:** Full access.
5. Choose **Create endpoint**. When all six show **Available**, you are done.

**Cost note:** interface endpoints bill per hour per Availability Zone, so six endpoints across two zones is the largest charge in this version. For a short-lived demo you can pick a single zone for each endpoint to halve it; production keeps both zones.

If you do not need Session Manager, you could skip `ssmmessages` and `ec2messages`, but then you would have no way to look inside an instance. `ssm` stays either way because the instances read the version parameter through it.

### 4.4 ECR repository

Open **Amazon ECR → Private registry → Repositories → Create repository**.

1. **Repository name:** `nextjs-alb-demo`. **Tag immutability:** **Immutable**, so a tag (a commit ID) can never be silently overwritten.
2. Turn on **Scan on push** (in the form, or under **Private registry → Scanning configuration**) so each image is checked for known vulnerabilities.
3. After creating it, open the repository, choose **Lifecycle Policy → Create rule**: priority `1`, description `keep last 20`, **Image status** Any, **Match criteria** Image count more than `20`, action Expire. This stops old images piling up and costing storage.

### 4.5 Log group

Open **CloudWatch → Logs → Log management → Create log group**. Name it `/nextjs-alb-demo/app` and set **Retention** to 7 days.

### 4.6 Version parameter

Open **Systems Manager → Parameter Store → Create parameter**. **Name:** `/nextjs-alb-demo/image-tag`, **Type:** String, **Value:** `none-yet`. Octopus Deploy overwrites this with the release number (the image tag) of each deployment, and new instances read it to decide which image to run.

### 4.7 IAM: the instance role

Open **IAM → Roles → Create role**, choose **AWS service** → **EC2**.

1. Attach the managed policies `AmazonSSMManagedInstanceCore` (Session Manager) and `AmazonEC2ContainerRegistryReadOnly` (pull images). Production tightens the second to this one repository.
2. Name the role `nextjs-alb-demo-ec2-role` and create it.
3. Open the role → **Add permissions → Create inline policy → JSON**, paste the policy below (replace `ACCOUNT_ID`), and name it `nextjs-alb-demo-ec2-app`. It lets instances read the version parameter and write container logs, nothing else.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadImageTag",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:ap-south-1:ACCOUNT_ID:parameter/nextjs-alb-demo/image-tag"
    },
    {
      "Sid": "WriteContainerLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:ap-south-1:ACCOUNT_ID:log-group:/nextjs-alb-demo/app:*"
    }
  ]
}
```

### 4.8 IAM: let GitHub push images without access keys

GitHub Actions can prove its identity to AWS with a short-lived OpenID Connect (OIDC) token, so you never store an AWS key in GitHub.

1. **IAM → Identity providers → Add provider**: type **OpenID Connect**, **Provider URL** `https://token.actions.githubusercontent.com`, **Audience** `sts.amazonaws.com`. Choose **Add provider**.
2. **IAM → Roles → Create role**, choose **Web identity**. Select the provider `token.actions.githubusercontent.com` and audience `sts.amazonaws.com`. Enter your **GitHub organization** (`GITHUB_OWNER`), **GitHub repository** `acme-status` and **GitHub branch** `main`. Skip attaching policies, name the role `nextjs-alb-demo-github-ci` and create it.
3. Open the role's **Trust relationships** tab and check the `token.actions.githubusercontent.com:sub` condition. This is what stops any other repository or branch from assuming the role, and it must match the `sub` claim GitHub actually sends, character for character. Check which format your repository uses:

   ```bash
   gh api repos/GITHUB_OWNER/acme-status/actions/oidc/customization/sub
   ```

   - If the output contains `"use_immutable_subject":true`, GitHub sends the **immutable** subject, which adds the numeric owner and repository IDs. Copy the `sub_claim_prefix` value and append `:ref:refs/heads/main`, for example `repo:GITHUB_OWNER@27818433/acme-status@1458522198:ref:refs/heads/main`. The console wizard in step 2 writes the old format, so choose **Edit trust policy** and replace the `sub` value with this one.
   - Otherwise the subject is the classic `repo:GITHUB_OWNER/acme-status:ref:refs/heads/main`, which the wizard already wrote.

   The immutable form keeps working if the owner or repository is renamed, and it cannot be claimed by someone who later takes over the old name.
4. **Add permissions → Create inline policy → JSON** with the policy below (replace `ACCOUNT_ID`), named `nextjs-alb-demo-ci`. It can push images to this one repository and nothing else; the rollout permissions belong to Octopus (4.9).
5. Copy the role's **ARN** from its summary page. You need it in 5.1, for the GitHub variable AWS\_ROLE\_ARN.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPushPull",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeImages",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      ],
      "Resource": "arn:aws:ecr:ap-south-1:ACCOUNT_ID:repository/nextjs-alb-demo"
    }
  ]
}
```

### 4.9 IAM: let Octopus Deploy roll out releases

Octopus Deploy does the rollout, so it gets its own narrow role: write the version parameter and start a refresh on this one ASG. Like GitHub, Octopus signs in with short-lived OpenID Connect credentials. You need your Octopus URL for this step, so create your Octopus Cloud instance (or have your server ready) first. OIDC sign-in to AWS needs Octopus Server 2024.1 or later ([AWS accounts](https://octopus.com/docs/infrastructure/accounts/aws)).

1. **IAM → Identity providers → Add provider**: type **OpenID Connect**, **Provider URL** your Octopus URL (for Octopus Cloud, `https://YOUR-INSTANCE.octopus.app`), **Audience** your Octopus host name without `https://` (for example `YOUR-INSTANCE.octopus.app`). Octopus puts the host name in the token's `aud` claim for AWS, not `api://default`; with the wrong audience every sign-in fails with "The web identity token provided could not be validated". Choose **Add provider**.
2. **IAM → Roles → Create role**, choose **Custom trust policy**, paste Policy 1 below (replace `ACCOUNT_ID`, and `OCTOPUS_HOST` with the host name only, no `https://`), and name the role `nextjs-alb-demo-octopus-role`.
3. **Add permissions → Create inline policy → JSON** with Policy 2 below (replace `ACCOUNT_ID`), named `nextjs-alb-demo-rollout`.
4. Copy the role's **ARN**. You need it in 5.2, where you paste it into the Octopus AWS account (it does not go into GitHub).

**Policy 1, for step 2: the trust policy.** It says who may assume the role (Octopus). Paste it into **Custom trust policy** when you create the role, and replace `ACCOUNT_ID` and `OCTOPUS_HOST`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/OCTOPUS_HOST" },
    "Action": ["sts:AssumeRoleWithWebIdentity", "sts:TagSession"],
    "Condition": {
      "StringEquals": { "OCTOPUS_HOST:aud": "OCTOPUS_HOST" },
      "StringLike": { "OCTOPUS_HOST:sub": "space:default:project:nextjs-alb-demo:*" }
    }
  }]
}
```

**Example of Policy 1 with the values filled in.** For account `123456789012` and an Octopus Cloud instance at `my-company.octopus.app`, the identity provider's URL is `https://my-company.octopus.app`, and `OCTOPUS_HOST` becomes `my-company.octopus.app` in all four places (the provider ARN, both condition keys and the audience value). The host must match the provider URL exactly, so use the full host name, not just the instance name:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/my-company.octopus.app" },
    "Action": ["sts:AssumeRoleWithWebIdentity", "sts:TagSession"],
    "Condition": {
      "StringEquals": { "my-company.octopus.app:aud": "my-company.octopus.app" },
      "StringLike": { "my-company.octopus.app:sub": "space:default:project:nextjs-alb-demo:*" }
    }
  }]
}
```

The subject starts with the space and project slugs, so only deployments of this project can assume the role. After you create the AWS account in Octopus (Part 5), compare the subject Octopus shows with this pattern and adjust the wildcard if they differ ([OIDC subject identifier](https://octopus.com/docs/infrastructure/accounts/openid-connect)).

**Policy 2, for step 3: the permissions policy.** It says what the role may do once assumed. Add it as an inline policy named `nextjs-alb-demo-rollout`, and replace only `ACCOUNT_ID`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RecordVersion",
      "Effect": "Allow",
      "Action": "ssm:PutParameter",
      "Resource": "arn:aws:ssm:ap-south-1:ACCOUNT_ID:parameter/nextjs-alb-demo/image-tag"
    },
    {
      "Sid": "RollAsg",
      "Effect": "Allow",
      "Action": "autoscaling:StartInstanceRefresh",
      "Resource": "arn:aws:autoscaling:ap-south-1:ACCOUNT_ID:autoScalingGroup:*:autoScalingGroupName/nextjs-alb-demo-asg"
    },
    {
      "Sid": "WatchAsg",
      "Effect": "Allow",
      "Action": ["autoscaling:DescribeInstanceRefreshes", "autoscaling:DescribeAutoScalingGroups"],
      "Resource": "*"
    }
  ]
}
```

You now have a network, an image registry, a place for logs and the version, and three roles with narrow permissions.

## Part 5: The pipeline: GitHub Actions builds, Octopus Deploy delivers

The pipeline has two halves with a clean hand-off. **GitHub Actions is CI**: it builds the image, pushes it to ECR and creates a release in Octopus. **Octopus Deploy is CD**: it records the version, rolls the Auto Scaling Group and reports success or failure, with a release history, environments and an audit trail. The workflow works before Octopus is connected (it simply publishes images), so you set up CI first and CD second.

### 5.1 CI: the GitHub Actions workflow

1. **Add a repository variable.** In GitHub open the repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**. Name it `AWS_ROLE_ARN` and paste the ARN of `nextjs-alb-demo-github-ci`. A role ARN is not a secret, so a variable is fine. Use the GitHub role from 4.8 here, not the Octopus role from 4.9; that one goes into Octopus in 5.2.
2. **Add the workflow file** at `.github/workflows/ci.yml`:

```yaml
name: build-and-release

on:
  push:
    branches: [main]

permissions:
  id-token: write   # lets the job request OIDC tokens (for AWS and for Octopus)
  contents: read

concurrency:
  group: release
  cancel-in-progress: false

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: nextjs-alb-demo
  RELEASE: 1.0.${{ github.run_number }}   # image tag and Octopus release number

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image (skipped if this release's image exists)
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          IMAGE="$REGISTRY/$ECR_REPOSITORY"
          if aws ecr describe-images --repository-name "$ECR_REPOSITORY" \
               --image-ids imageTag="$RELEASE" >/dev/null 2>&1; then
            echo "Image $RELEASE already exists, skipping build"
          else
            docker build --build-arg APP_VERSION="${GITHUB_SHA}" -t "$IMAGE:$RELEASE" .
            docker tag "$IMAGE:$RELEASE" "$IMAGE:${GITHUB_SHA}"
            docker push "$IMAGE:$RELEASE"
            docker push "$IMAGE:${GITHUB_SHA}"
          fi

      - name: Log in to Octopus
        if: ${{ vars.OCTOPUS_URL != '' }}
        uses: OctopusDeploy/login@v1
        with:
          server: ${{ vars.OCTOPUS_URL }}
          service_account_id: ${{ vars.OCTOPUS_SERVICE_ACCOUNT_ID }}

      - name: Create the release
        if: ${{ vars.OCTOPUS_URL != '' }}
        uses: OctopusDeploy/create-release-action@v3
        with:
          space: Default
          project: nextjs-alb-demo
          release_number: ${{ env.RELEASE }}
          ignore_existing: true   # a re-run reuses the release instead of failing

      - name: Deploy it to Demo
        if: ${{ vars.OCTOPUS_URL != '' }}
        uses: OctopusDeploy/deploy-release-action@v3
        with:
          space: Default
          project: nextjs-alb-demo
          release_number: ${{ env.RELEASE }}
          environments: Demo
```

Every image gets two tags: the commit ID (traceability) and the release number such as `1.0.7` (what Octopus and the instances use). Tags are immutable, so a re-run of the same workflow skips the build instead of failing. The two Octopus steps only run once you set the `OCTOPUS_URL` variable in 5.3. Action versions and input names move on, so check each action's page for the current major version and inputs before you rely on them.

3. **Commit and push.**

```bash
git add .github/workflows/ci.yml
git commit -m "Add CI workflow"
git push
```

4. **Watch the first run.** Open the repo's **Actions** tab. The run should go green: it builds and pushes the image and skips the Octopus steps. In **ECR → nextjs-alb-demo** you now see one image with two tags, the commit ID and `1.0.N`.

If the **Actions** tab shows no run at all, check your branch. The workflow only triggers on pushes to `main`, and a new local repo may default to `master`. Run `git branch --show-current`; if it prints `master`, run `git branch -M main` and `git push -u origin main`.

If the run fails at the AWS sign-in step with "Not authorized to perform sts:AssumeRoleWithWebIdentity", the role's trust policy does not match the token's `sub` claim exactly. The most common cause is a repository that sends the immutable subject (`repo:OWNER@ID/REPO@ID:...`) while the trust policy has the classic form the console wizard writes. Recheck step 3 of 4.8.

### 5.2 CD: the Octopus Deploy project

In the Octopus web UI:

1. **Infrastructure → Environments → New environment**: name it `Demo`.
2. **Infrastructure → Accounts → Add account → AWS Account**: choose **OpenID Connect**, name it `aws-demo`, paste the ARN of `nextjs-alb-demo-octopus-role`, restrict it to the `Demo` environment, and choose **Save**. Do not expect **Save and test** to pass: the test signs in with the subject `space:default:account:aws-demo`, which the 4.9 trust policy deliberately rejects because it only admits this project's deployments. The first deployment in 5.3 is the real test.
3. **Library → Lifecycles → Add lifecycle**: name it `Demo only` with one phase, `Demo`, holding the `Demo` environment. The Default Lifecycle has no explicit phases, so it steps through every environment in your space in order; if your instance also has Development, Staging or Production, a release cannot go straight to `Demo` ("The release has not been deployed to the required environments"). Then **Projects → Add project**: name `nextjs-alb-demo`, lifecycle `Demo only`.
4. In the project, open **Variables → Project** and add:
   - `AwsAccount`, type **Amazon Web Services Account**, value `aws-demo`
   - `ParameterName`, value `/nextjs-alb-demo/image-tag`
   - `AsgName`, value `nextjs-alb-demo-asg`
5. Open **Process → Add step → Run an AWS CLI Script** and name it `Set image tag`. Choose the `AwsAccount` variable for authentication, set the script source to **Inline source code**, and paste this Bash script ([step reference](https://octopus.com/docs/deployments/custom-scripts/aws-cli-scripts)). The release number is the image tag:

```bash
set -euo pipefail
aws ssm put-parameter --region ap-south-1 \
  --name "#{ParameterName}" --type String --overwrite \
  --value "#{Octopus.Release.Number}"
```

6. Add a second **Run an AWS CLI Script** step, `Roll out`, with the same account variable and this script. Until the ASG exists (Part 6) it only reports that; afterwards it starts the rolling replacement and waits, so a bad release shows up as a red deployment, not a half-finished rollout:

```bash
set -euo pipefail
REGION=ap-south-1
COUNT=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
  --auto-scaling-group-names "#{AsgName}" \
  --query 'length(AutoScalingGroups)' --output text)
if [ "$COUNT" = "0" ]; then
  echo "ASG #{AsgName} does not exist yet: version recorded, nothing to roll"
  exit 0
fi
ID=$(aws autoscaling start-instance-refresh --region "$REGION" \
  --auto-scaling-group-name "#{AsgName}" \
  --preferences '{"MinHealthyPercentage":100,"MaxHealthyPercentage":200,"InstanceWarmup":120}' \
  --query InstanceRefreshId --output text)
for i in $(seq 1 120); do
  S=$(aws autoscaling describe-instance-refreshes --region "$REGION" \
    --auto-scaling-group-name "#{AsgName}" --instance-refresh-ids "$ID" \
    --query 'InstanceRefreshes[0].Status' --output text)
  echo "Instance refresh $ID: $S"
  case "$S" in
    Successful) exit 0 ;;
    Failed|Cancelled|RollbackFailed|RollbackSuccessful) exit 1 ;;
  esac
  sleep 15
done
echo "Timed out waiting for the refresh"; exit 1
```

7. On **Octopus Cloud** the default worker may not have the AWS CLI. In both steps set the **Execution location** to run in a container and pick an image that has Bash and the AWS CLI (for example Octopus's worker-tools image).

This tutorial uses one environment and no approval, so every push deploys. Real teams add more environments to the lifecycle and a **manual intervention** step in front of production; the checklist at the end lists it.

### 5.3 Connect GitHub to Octopus and run the first deployment

1. In Octopus open **Configuration → Users → Add service account**, name it `github-actions`, and give it a team or role that can create releases and deploy the project. On its page add an **OpenID Connect** identity with issuer `https://token.actions.githubusercontent.com` and the same subject you put in the AWS trust policy in step 3 of 4.8: the immutable `repo:GITHUB_OWNER@ID/acme-status@ID:ref:refs/heads/main` if your repository uses it, otherwise `repo:GITHUB_OWNER/acme-status:ref:refs/heads/main` ([GitHub Actions OIDC to Octopus](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-octopus-deploy)). Copy the service account's ID.
2. In GitHub add two more repository variables: `OCTOPUS_URL` (your Octopus address) and `OCTOPUS_SERVICE_ACCOUNT_ID`. No API key is stored anywhere.
3. In the **Actions** tab open the last run and choose **Re-run all jobs**. The build is skipped because the image exists, and the Octopus steps now run.
4. In Octopus open the project. Release `1.0.N` is deployed to `Demo`. The task log shows `Set image tag`, then `Roll out` reporting that the ASG does not exist yet.
5. In **Systems Manager → Parameter Store** the parameter `/nextjs-alb-demo/image-tag` now holds `1.0.N`, ready for the instances you launch in Part 6.

If Octopus fails at the AWS step with an AssumeRoleWithWebIdentity error, the trust policy from 4.9 does not match: compare the issuer, audience and subject with what the Octopus account page shows.

### 5.4 Why this split, and two design notes

- **Why not one tool?** The commit ID and the image belong to CI. Which release is live, where, who approved it and how to undo it belong to CD. Octopus keeps that record per release and environment, and a rollback is simply deploying an older release.
- **Keeping Octopus calls inside the VPC.** Octopus only calls control-plane APIs (SSM, Auto Scaling), never your instances or the ALB. If policy forbids even that traffic crossing the internet, run a self-hosted Octopus **worker** (a Linux instance or container in the private subnets) and add interface endpoints for `autoscaling` and `ssm` (you already have `ssm`).
- **No Tentacles on the ASG instances.** Instances come and go, so each launch would need to register and each termination to deregister, usually with a Lambda on an Auto Scaling lifecycle hook plus deployment target triggers ([forum thread](https://help.octopus.com/t/using-octopus-deploy-aws-auto-scaling-groups/23682)). The version parameter plus Instance Refresh already does that job without any agent on the instances.
- **If you later move to ECS or EKS**, Octopus has native deployment targets for both. The releases, environments and approvals stay; only the two scripts change.

## Part 6: Launch template, target group, ALB and ASG

Now the runtime. The launch template's user data is short on purpose: it installs Docker, looks up which version to run, pulls that image from ECR and starts it. Nothing is compiled on the instance.

### 6.1 Launch template

In **EC2 → Instances → Launch Templates → Create launch template**:

1. **Name:** `nextjs-alb-demo-lt`. **Description:** `Runs the Next.js container from ECR`. Tick **Provide guidance to help me set up a template that I can use with EC2 Auto Scaling**.
2. **AMI:** Quick Start → **Amazon Linux 2023 AMI** (64-bit x86). **Instance type:** `t3.micro`. **Key pair:** **Don't include in launch template**.
3. **Network settings:** leave the subnet out (the ASG chooses). Under **Firewall**, choose **Select existing security group** and pick `nextjs-alb-demo-ec2-sg`.
4. **Resource tags:** add `Name` = `nextjs-alb-demo` and `Project` = `nextjs-alb-demo`, resource type **Instances**.
5. Expand **Advanced details** and set:
   - **IAM instance profile:** `nextjs-alb-demo-ec2-role`.
   - **Detailed CloudWatch monitoring:** Enable (1-minute metrics, so scaling reacts faster).
   - **Metadata version:** **V2 only (token required)**.
   - **Metadata response hop limit:** `2`. The default of 1 would stop the container from reaching the metadata service, so the page could not show the instance ID.
   - **User data:** paste the script below as plain text.
6. Choose **Create launch template**.

```bash
#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

REGION=ap-south-1
REPO=nextjs-alb-demo

# The Amazon Linux package repository is reached through the S3 gateway endpoint
dnf install -y docker
systemctl enable --now docker

# Get the account ID from instance metadata, so no STS endpoint is needed
TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
ACCOUNT_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/dynamic/instance-identity/document \
  | grep -oP '"accountId"\s*:\s*"\K[0-9]+')
INSTANCE_ID=$(cat /var/lib/cloud/data/instance-id)
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# These calls go through the ssm, ecr.api, ecr.dkr and logs VPC endpoints
TAG=$(aws ssm get-parameter --name /nextjs-alb-demo/image-tag \
  --query Parameter.Value --output text --region "$REGION")
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker run -d --name app --restart unless-stopped \
  -p 3000:3000 \
  --log-driver awslogs \
  --log-opt awslogs-region="$REGION" \
  --log-opt awslogs-group=/nextjs-alb-demo/app \
  --log-opt awslogs-stream="$INSTANCE_ID" \
  "$REGISTRY/$REPO:$TAG"
```

This only works if Part 5's first Octopus deployment already replaced the placeholder `none-yet` in the parameter with a real release number. If you skipped that, instances will fail to pull an image and the ASG will keep replacing them.

### 6.2 Target group

In **EC2 → Load Balancing → Target Groups → Create target group**:

1. **Target type:** Instances. **Name:** `nextjs-alb-demo-tg`. **Protocol:** HTTP, **Port:** `3000`. **VPC:** `nextjs-alb-demo-vpc`.
2. **Health check path:** `/api/health`. Under **Advanced health check settings**: healthy threshold `2`, unhealthy threshold `3`, interval `15` seconds.
3. Choose **Next**, register no targets (the ASG does that), and **Create target group**.
4. Open it → **Attributes → Edit** and set **Deregistration delay** to `30` seconds, so in-flight requests finish but rollouts and cleanup are not slow.

### 6.3 Internal Application Load Balancer

In **EC2 → Load Balancing → Load Balancers → Create load balancer → Application Load Balancer**:

1. **Name:** `nextjs-alb-demo-alb`. **Scheme:** **Internal**. **IP address type:** IPv4.
2. **Network mapping:** VPC `nextjs-alb-demo-vpc`. Tick both Availability Zones and choose the **private** subnet in each. There are no public subnets to pick.
3. **Security groups:** remove `default`, select `nextjs-alb-demo-alb-sg`.
4. **Listener:** HTTP port 80, default action forward to `nextjs-alb-demo-tg`. Add the tag `Project` = `nextjs-alb-demo` and choose **Create load balancer**.
5. When the state is **Active**, copy the **DNS name** (it starts with `internal-`). It resolves only to private addresses inside the VPC, so you cannot open it from the internet. Part 7 uses it from a test client inside the VPC.

### 6.4 Auto Scaling Group

In **EC2 → Auto Scaling → Auto Scaling Groups → Create Auto Scaling group**:

1. **Name:** `nextjs-alb-demo-asg` (it must match the name in the Octopus role's policy and in the AsgName variable). **Launch template:** `nextjs-alb-demo-lt`. Choose **Next**.
2. **VPC:** `nextjs-alb-demo-vpc`. **Subnets:** select both **private** subnets. Choose **Next**.
3. **Load balancing:** attach to an existing load balancer → choose from target groups → `nextjs-alb-demo-tg`. Tick **Turn on Elastic Load Balancing health checks** and set **Health check grace period** to `180` seconds. Choose **Next**.
4. **Group size:** desired `2`, minimum `2`, maximum `4`. Keep the maximum at 4: the rolling deploy briefly runs old and new instances together. **Scaling:** Target tracking, metric **Average CPU utilization**, target `30` (low for the demo; real services use 50 to 70), warm-up `120` seconds. Choose **Next**.
5. Skip notifications, add the tag `Project` = `nextjs-alb-demo`, review and **Create Auto Scaling group**.

### 6.5 Check it

- In the ASG's **Activity** tab, two instances launch. In **EC2 → Instances** they have no public IPv4 address and sit in different zones.
- In **Target Groups → Targets**, both go from `initial` to `healthy` in about 3 to 5 minutes.
- To look inside, select an instance and choose **Connect → Session Manager → Connect**. In the shell, `sudo docker ps` should list the `app` container, and `curl -s http://localhost:3000/api/health` should return `{"status":"ok"}`.
- Finally, in Octopus open the project's variables and confirm that the variable `AsgName` = `nextjs-alb-demo-asg`. The Roll out step skipped itself until now because the group did not exist. From your next deployment on, it starts an Instance Refresh.

If targets stay unhealthy, see the troubleshooting table at the end. The two fastest checks are the instance's **Get system log** and, once connected with Session Manager, `sudo docker logs app`.

## Part 7: Test and operate it from inside the VPC

The ALB is internal, so your browser cannot reach it. You test from a small **test client** instance inside the VPC, using a Session Manager shell in the console. The client is not part of the ASG, so it keeps running while the ASG replaces instances.

### 7.1 Launch a test client

In **EC2 → Instances → Launch instances**:

1. **Name:** `nextjs-alb-demo-client`, with the tag `Project` = `nextjs-alb-demo`. **AMI:** Amazon Linux 2023. **Instance type:** `t3.micro`. **Key pair:** **Proceed without a key pair**.
2. **Network settings → Edit:** VPC `nextjs-alb-demo-vpc`, either private subnet, and **Auto-assign public IP** disabled. **Firewall:** select the existing group `nextjs-alb-demo-ec2-sg`.
3. **Advanced details → IAM instance profile:** `nextjs-alb-demo-ec2-role`.
4. Choose **Launch instance**. After a minute or two, select it and choose **Connect → Session Manager → Connect**. If Connect is not offered yet, wait a minute for the agent to register through the endpoints.

In the shell, set the ALB address once. Copy the **DNS name** from **EC2 → Load Balancers** and use it in every command below:

```bash
ALB=<your ALB DNS name>
curl -s http://$ALB/api/health
```

The second command should print `{"status":"ok"}`.

### 7.2 See the load balancer work

```bash
for i in $(seq 1 10); do curl -s http://$ALB/ | grep -o 'i-[0-9a-f]\{8,\}' | head -1; done
```

Two instance IDs alternate, because the ALB picks a target for each request. Compare them with the IDs in **Target Groups → Targets**.

### 7.3 Ship a change with no downtime

1. On your own machine, change the heading in `app/page.js` to `<h1>Acme Status v2</h1>`, then commit and push to `main`:

```bash
git commit -am "Heading v2"
git push
```

2. In the client's Session Manager shell, start a poller that prints the HTTP status once a second. Leave it running (Ctrl+C stops it):

```bash
while true; do curl -s -o /dev/null -w "%{http_code} " http://$ALB/; sleep 1; done
```

3. Open the repo's **Actions** tab and watch the run build the image, push it and create the Octopus release. Then open that release in Octopus Deploy: its task log shows Set image tag, then Roll out, which keeps polling until the Instance Refresh succeeds, so a failed rollout turns the deployment red.
4. In AWS, open **Auto Scaling Groups → `nextjs-alb-demo-asg` → Instance refresh** and watch the percentage climb.
5. The poller keeps printing `200` the whole time. With minimum healthy 100% and maximum 200%, the ASG first starts two new instances, waits for them to pass health checks and the 2-minute warm-up, and only then terminates the old ones.
6. After about 6 to 8 minutes, press Ctrl+C and run `curl -s http://$ALB/ | grep -o 'Acme Status v2'`. It prints the new heading. In ECR there are now two images (each with a commit-ID tag and a release-number tag), and the parameter holds the new release number.

### 7.4 Roll back

Three ways, all safe because the old image is still in ECR:

- **In Octopus (the normal way):** open the project's **Releases**, choose the earlier release and **Deploy** it to `Demo`. The same two steps write that release number to the parameter and run the rolling refresh, and the deployment history records who rolled back and when.
- **Break-glass, in the AWS console (when Octopus is unavailable):** copy the previous release number (for example 1.0.1) from **ECR → `nextjs-alb-demo` → Images**. Edit the parameter `/nextjs-alb-demo/image-tag` in Parameter Store and set that value. Then open the ASG's **Instance refresh** tab, choose **Start instance refresh**, and set minimum healthy `100`, maximum healthy `200`, warm-up `120`. The same rolling replacement runs, now back to the old version.
- **Through Git (audit trail):** `git revert HEAD` then `git push`. The pipeline builds the reverted code as a new release and Octopus rolls it out like any other.

Because new instances read the parameter when they boot, any scale-out or self-healing during or after a rollback also uses the version you chose.

### 7.5 Self-healing

With the poller from 7.3 running, go to **EC2 → Instances** and terminate one `nextjs-alb-demo` instance (not the client). The poller keeps printing `200` because the other instance answers. In the ASG's **Activity** tab, a replacement launches within a minute or two, boots, pulls the current image and joins the target group.

### 7.6 Scale out under load

In the client shell, send CPU-heavy requests to your own demo ALB, in the background:

```bash
seq 1 3000 | xargs -P 40 -I{} curl -s -o /dev/null http://$ALB/api/burn &
```

1. In the ASG, open **Monitoring → EC2** and watch **Average CPU utilization** climb past 30%.
2. After 3 to 5 minutes the **Activity** tab shows new instances launching and **Desired capacity** rises toward 4.
3. Stop the load with `kill %1`. Scale-in takes about 15 minutes of low CPU, so don't wait for it.

### 7.7 Logs, access and image scanning

- **Logs:** **CloudWatch → Log groups → `/nextjs-alb-demo/app`** has one log stream per instance ID, and the logs survive when an instance is replaced.
- **Access without SSH:** select any instance and choose **Connect → Session Manager → Connect**. Try `sudo docker ps` and `sudo docker logs app`. No inbound ports are open and no key pair exists.
- **Vulnerabilities:** in **ECR → `nextjs-alb-demo` → Images**, the scan results column shows findings for each image.

### 7.8 Reaching it from your own browser later

An internal ALB has no public path, which is the point. When you want people to use it, choose the exposure deliberately:

- **AWS Client VPN** lets your laptop join the VPC, so the ALB's DNS name works in your browser. It can be set up in the console and bills per hour while in use.
- **Site-to-Site VPN or Direct Connect** does the same for an office or data center network.
- **CloudFront with a VPC origin** pointing at the internal ALB is the usual way to publish a private origin to the internet: the ALB stays private and only CloudFront is public.
- **Session Manager port forwarding** (needs the AWS CLI and its plugin on your laptop) forwards a local port to the ALB through the test client. It is handy for quick debugging.

## Part 8: Delete everything, in the right order

Two parts of this setup bill by the hour even when idle: the **interface endpoints** and the **ALB**. If you stop for the day, do this cleanup rather than leaving them running. Check that the console region is still **Mumbai**.

**The order matters.** Delete from the top of the stack downward: things that use a resource go before the resource itself.

1. **Stop any load** still running in a Session Manager shell (`kill %1`, or close the tab).
2. **Disable the pipeline.** In GitHub, open **Actions → build-and-release → … menu → Disable workflow**, so a stray push cannot start a rollout while you delete things.
3. **Auto Scaling group.** **EC2 → Auto Scaling Groups**, select `nextjs-alb-demo-asg` → **Delete**, type `delete`. This terminates its instances.
4. **Test client.** **EC2 → Instances**, select `nextjs-alb-demo-client` → **Instance state → Terminate**. Wait until all demo instances show **Terminated**.
5. **Load balancer.** **EC2 → Load Balancers**, select `nextjs-alb-demo-alb` → **Actions → Delete load balancer**. Wait until it disappears.
6. **Target group.** **Target Groups**, select `nextjs-alb-demo-tg` → **Actions → Delete**.
7. **Launch template.** **Launch Templates**, select `nextjs-alb-demo-lt` → **Actions → Delete template**.
8. **Interface endpoints.** **VPC → Endpoints**, select the six endpoints named `nextjs-alb-demo-...` (ecr-api, ecr-dkr, ssm, ssmmessages, ec2messages, logs) → **Actions → Delete VPC endpoints**, type `delete`. Wait until they are gone; this stops the biggest hourly charge.
9. **Security groups.** **EC2 → Security Groups**: delete `nextjs-alb-demo-endpoints-sg` first, then `nextjs-alb-demo-ec2-sg`, then `nextjs-alb-demo-alb-sg`. Each one references the next, so this order is required. If a delete says a dependent object exists, wait a minute or two for network interfaces to disappear and retry.
10. **VPC.** **VPC → Your VPCs**, select `nextjs-alb-demo-vpc` → **Actions → Delete VPC**. The dialog lists the subnets, route tables and S3 gateway endpoint that go with it; confirm.
11. **ECR repository.** **ECR → Repositories**, select `nextjs-alb-demo` → **Delete**, type `delete`. This also deletes every image in it.
12. **Log group.** **CloudWatch → Log groups**, select `/nextjs-alb-demo/app` → **Actions → Delete log group(s)**.
13. **Parameter.** **Systems Manager → Parameter Store**, select `/nextjs-alb-demo/image-tag` → **Delete**.
14. **IAM.** **Roles**: delete `nextjs-alb-demo-ec2-role` and `nextjs-alb-demo-github-ci` (their inline policies go with them). **Identity providers**: delete `token.actions.githubusercontent.com`, unless another project of yours uses it.
15. **Octopus Deploy and its IAM pieces.** In IAM delete the role `nextjs-alb-demo-octopus-role` and the identity provider for your Octopus host. In Octopus delete the project `nextjs-alb-demo`, the `Demo` environment, the `aws-demo` account and the `github-actions` service account (or cancel the Octopus Cloud trial).
16. **GitHub.** Delete the repository variables `AWS_ROLE_ARN`, `OCTOPUS_URL` and `OCTOPUS_SERVICE_ACCOUNT_ID`, and delete the repository itself if you no longer need it (Settings → General → Danger Zone).

### Verify nothing is left

In the Mumbai region, each of these should show nothing named `nextjs-alb-demo`:

- **Auto Scaling Groups**, **Load Balancers**, **Target Groups**, **Launch Templates**: empty.
- **Instances**: only **Terminated** entries, which vanish by themselves after about an hour.
- **VPC → Endpoints**: none from this project. **Your VPCs**: no `nextjs-alb-demo-vpc`.
- **Network Interfaces**: none from this project.
- **ECR**, **CloudWatch log groups**, **Parameter Store**: empty of this project. **IAM roles** and **identity providers**: gone.
- **CloudWatch → Alarms**: no `TargetTracking-nextjs-alb-demo-asg-...` alarms (they go with the ASG).

For a last sweep, use **Resource Groups & Tag Editor → Tag Editor** in Mumbai with the tag `Project` = `nextjs-alb-demo`. Check **Billing → Cost Explorer** the next day to confirm the hourly charges stopped.

## Production checklist and troubleshooting

You now have the core of a real delivery pipeline on a fully private network. A production service adds the items below, roughly in the order most teams tackle them.

### What a real production setup still needs

- **A deliberate way in.** Decide how people reach the internal ALB: Client VPN, a site VPN, or CloudFront with a VPC origin (see 7.8).
- **HTTPS.** Even inside a VPC, use TLS. With a domain, an ACM certificate works on an internal ALB, with a Route 53 private hosted zone pointing the name at it. Add a 443 listener, allow 443 in the ALB security group, and redirect port 80. Without a domain, use a private CA.
- **Alarms and automatic rollback.** CloudWatch alarms on ALB 5xx rate, unhealthy host count and latency, notifying an SNS topic. Instance Refresh can roll back automatically when an alarm fires during a deploy.
- **Resilient networking.** Interface endpoints in every Availability Zone you use, endpoint policies that limit what can be reached through them, and VPC Flow Logs.
- **Private CI too.** GitHub-hosted runners call ECR, and Octopus Deploy calls SSM and Auto Scaling, all public AWS APIs with short-lived credentials. If policy forbids any public path, run self-hosted GitHub runners and an Octopus worker inside the VPC, with endpoints for ECR, SSM and Auto Scaling.
- **Protection at the ALB.** AWS WAF works on internal ALBs too (managed rule groups, rate limits). Add ALB access logs to S3.
- **Secrets and configuration.** Keep them out of the image. Use Secrets Manager or Parameter Store SecureString (reachable through the `ssm` and Secrets Manager endpoints) and inject them when the container starts.
- **Release controls.** Branch protection on `main`, required reviews, and, in Octopus, a lifecycle with Staging and Production environments, a manual intervention (approval) step before production, and scoped variables and AWS accounts per environment, ideally one AWS account each.
- **Supply chain.** Pin base images by digest, enable Dependabot, and fail the pipeline on serious scan findings.
- **Patching.** Launch from the latest Amazon Linux AMI on a schedule, and run an Instance Refresh regularly so instances are never old.
- **Infrastructure as code.** Recreate everything you clicked here in Terraform or AWS CDK so environments are repeatable and reviewable, and the pipeline can manage them.
- **A better home for containers.** ECS (on Fargate or EC2) runs this same image with built-in rolling deploys, rollbacks and scaling, and removes the Docker-on-EC2 plumbing. This tutorial shows the fundamentals; ECS is where most teams end up.

### Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Actions fails at AWS sign-in ("not authorized to perform sts:AssumeRoleWithWebIdentity") | Trust policy `sub` does not match the token (often: the repo sends the immutable subject with owner/repo IDs but the policy has the classic form), or `id-token: write` is missing | Run `gh api repos/GITHUB_OWNER/acme-status/actions/oidc/customization/sub`; if `use_immutable_subject` is true, set the trust condition to `sub_claim_prefix` + `:ref:refs/heads/main`, otherwise `repo:GITHUB_OWNER/acme-status:ref:refs/heads/main` (case-sensitive). Also check the `permissions` block in the workflow |
| Pushed to GitHub but the workflow never starts | Your local branch is `master` (or another name), but the workflow only triggers on `main`, or the file is not at `.github/workflows/ci.yml` | Run `git branch -M main` then `git push -u origin main`. Also confirm the file path on github.com and that Actions are enabled under Settings → Actions |
| AccessDenied on ECR (in Actions) or on SSM or Auto Scaling (in Octopus) | A placeholder in the policy was not replaced, or a name differs | Make sure `ACCOUNT_ID`, the region and the resource names in the GitHub CI and Octopus rollout policies match what you created |
| Image push says the tag already exists | Immutable tags and a rebuilt commit | Expected; the workflow skips the build when the image exists. Re-run only if the earlier run failed before the push finished |
| Targets unhealthy, "request timed out" | The instance security group does not allow 3000 from the ALB group | Recheck `nextjs-alb-demo-ec2-sg` |
| Targets unhealthy and instances keep being replaced | The container never started | Use **Get system log**, or Session Manager: `sudo cat /var/log/user-data.log` and `sudo docker logs app`. Common causes: the parameter still says `none-yet`, or a VPC endpoint or the S3 gateway endpoint is missing |
| `dnf install` fails or hangs at boot | The S3 gateway endpoint is missing or not attached to the private route tables | Check **VPC → Endpoints**; the gateway endpoint must list both private route tables |
| `docker pull` or login fails | The `ecr.api` or `ecr.dkr` endpoint is missing, or `nextjs-alb-demo-endpoints-sg` does not allow 443 from the instance group | Check that both endpoints are **Available** with **Enable DNS name** on, and recheck the security group |
| Session Manager says the instance is not connected | The `ssm`, `ssmmessages` or `ec2messages` endpoint is missing, or the role lacks `AmazonSSMManagedInstanceCore` | Check the three endpoints and the role; wait a few minutes after boot |
| `curl` to the ALB from the test client hangs or is refused | ALB security group does not allow the client's address, or wrong DNS name | The ALB group must allow HTTP from `10.0.0.0/16`; copy the `internal-...` DNS name exactly |
| Page shows "not running on EC2" | The container cannot reach the metadata service | Set **Metadata response hop limit** to 2 in the launch template, create a new version, set it as default and run an instance refresh |
| Instance refresh never finishes | New instances fail health checks, or the group is at max size | Read the ASG **Activity** tab; fix the cause or cancel the refresh and deploy the previous release in Octopus |
| No scale-out during the load test | CPU not above target long enough | Keep the load running 5+ minutes, or lower the target value in the scaling policy |
| Deleting the VPC or a security group fails | Endpoints, network interfaces or security group references remain | Follow the Part 8 order: endpoints, then security groups, then the VPC |
| Octopus deployment fails at the AWS step ("web identity token provided could not be validated", or AssumeRoleWithWebIdentity) | The IAM provider audience is not the Octopus host name (Octopus sends the host as `aud`, not `api://default`), or the subject does not match the role's trust policy | Compare the issuer, audience and subject on the Octopus AWS account with the 4.9 trust policy; for Octopus Cloud the issuer is your instance URL |
| Actions run is green but Octopus shows no release | OCTOPUS\_URL is not set, or the service account cannot create releases | Set the two Octopus variables from 5.3, check the service account's permissions, and read the Octopus steps in the Actions log |

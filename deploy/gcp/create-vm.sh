#!/usr/bin/env bash
# GCP: e2-small (or e2-micro for labs) Compute Engine VM + Docker.
# Cloud Run cannot accept inbound SMTP, so a tiny VM is the low-cost path.
# Publish 587 (TLS) to Google mail hosts, not port 25 to the internet.
set -euo pipefail
: "${PROJECT:?}"
: "${ZONE:=us-central1-a}"
: "${NAME:=signer}"

gcloud config set project "$PROJECT"
gcloud compute firewall-rules create signer-https --allow tcp:80,tcp:443 --target-tags=signer || true
gcloud compute firewall-rules create signer-smtp-587 --allow tcp:587 --target-tags=signer --description="Google content-compliance route (TLS). Restrict source ranges to Google mail IPs." || true
gcloud compute instances create "$NAME" \
  --zone "$ZONE" \
  --machine-type e2-small \
  --tags signer \
  --image-family ubuntu-2204-lts \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 20GB \
  --metadata=startup-script='#!/bin/bash
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
'

echo "SSH: gcloud compute ssh $NAME --zone $ZONE"
echo "Then follow README.md (Google Cloud): clone, .env, Caddy, docker compose up -d"
echo "Do not open TCP 25. Return mail via smtp-relay.gmail.com:587. Tighten signer-smtp-587 sources to Google mail IP ranges."

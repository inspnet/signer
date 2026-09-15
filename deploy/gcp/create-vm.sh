#!/usr/bin/env bash
# GCP: e2-small (or e2-micro for labs) Compute Engine VM + Docker.
# Cloud Run cannot accept inbound SMTP, so a tiny VM is the low-cost path.
set -euo pipefail
: "${PROJECT:?}"
: "${ZONE:=us-central1-a}"
: "${NAME:=signer}"

gcloud config set project "$PROJECT"
gcloud compute firewall-rules create signer-mail --allow tcp:22,tcp:25,tcp:80,tcp:443,tcp:587,tcp:2525,tcp:3000 --target-tags=signer || true
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
echo "GCP blocks outbound port 25 by default. Return mail via smtp-relay.gmail.com:587. Request SMTP only if you must hit Microsoft MX on 25."

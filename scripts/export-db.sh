#!/bin/bash
# Export the OpenMind PostgreSQL database from the local Docker container

echo "🚀 Backing up local OpenMind database..."
docker exec -t openmind-db pg_dump -c -U openmind openmind > openmind-backup.sql

echo "✅ Backup complete! File saved as: openmind-backup.sql"
echo ""
echo "You can now upload this file to your Coolify VPS."

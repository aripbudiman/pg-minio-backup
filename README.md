# pg-minio-backup

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## cara menjalankan backup postgre sql

```bash
bun run backup.ts
```

jika ingin dijalankan di jam 02:00 cronjobnya

```bash
0 2 * * * cd /path/ke/pg-minio-backup && /home/user/.bun/bin/bun run backup.ts >> backup.log 2>&1
```

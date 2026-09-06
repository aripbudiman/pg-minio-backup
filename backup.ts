import {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

// 1. Konfigurasi
const PG_HOST = process.env.PG_HOST || "localhost";
const PG_PORT = process.env.PG_PORT || "5432";
const PG_USER = process.env.PG_USER || "postgres";
const PG_PASSWORD = process.env.PG_PASSWORD || "";
const PG_DATABASE = process.env.PG_DATABASE || "postgres";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "backup-db";
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === "true";
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "7", 10);

const s3 = new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: "us-east-1",
    credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
    tls: MINIO_USE_SSL,
});

// Mapping nama bulan Bahasa Indonesia ke angka index bulan (0 - 11)
const MONTH_MAP_ID: Record<string, number> = {
    januari: 0,
    februari: 1,
    maret: 2,
    april: 3,
    mei: 4,
    juni: 5,
    juli: 6,
    agustus: 7,
    september: 8,
    oktober: 9,
    november: 10,
    desember: 11,
};

// Helper membuat nama folder: "tanggal-nama_bulan-tahun"
function getBackupFolderName(date = new Date()): string {
    const day = String(date.getDate()).padStart(2, "0");
    const month = date.toLocaleString("id-ID", { month: "long" });
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

// Helper parsing nama folder "DD-Bulan-YYYY" kembali ke objek Date
function parseFolderDate(folderName: string): Date | null {
    const parts = folderName.split("-");
    if (parts.length !== 3) return null;

    const day = parseInt(parts[0], 10);
    const monthName = parts[1].toLowerCase();
    const year = parseInt(parts[2], 10);

    const monthIndex = MONTH_MAP_ID[monthName];
    if (monthIndex === undefined || isNaN(day) || isNaN(year)) return null;

    return new Date(year, monthIndex, day);
}

// Fungsi membersihkan backup yang lebih tua dari RETENTION_DAYS
async function cleanOldBackups() {
    if (RETENTION_DAYS <= 0) return;

    console.log(`\n[+] Mengecek backup lama (retensi: ${RETENTION_DAYS} hari)...`);

    const now = new Date();
    const cutoffDate = new Date();
    cutoffDate.setDate(now.getDate() - RETENTION_DAYS);
    cutoffDate.setHours(0, 0, 0, 0); // batas awal hari

    console.log(`[+] Backup sebelum tanggal ${getBackupFolderName(cutoffDate)} akan dihapus.`);

    // Ambil semua objek di bucket
    let isTruncated: boolean | undefined = true;
    let continuationToken: string | undefined = undefined;
    const foldersToDelete = new Set<string>();
    const objectsToDelete: { Key: string }[] = [];

    while (isTruncated) {
        const listCmd = new ListObjectsV2Command({
            Bucket: MINIO_BUCKET,
            ContinuationToken: continuationToken,
        });
        const res = await s3.send(listCmd);

        if (res.Contents) {
            for (const item of res.Contents) {
                if (!item.Key) continue;

                // Ambil prefix nama folder (misal: "05-September-2026/schema.sql.gz" -> "05-September-2026")
                const folderName = item.Key.split("/")[0];
                const folderDate = parseFolderDate(folderName);

                if (folderDate && folderDate < cutoffDate) {
                    foldersToDelete.add(folderName);
                    objectsToDelete.push({ Key: item.Key });
                }
            }
        }

        isTruncated = res.IsTruncated;
        continuationToken = res.NextContinuationToken;
    }

    if (objectsToDelete.length === 0) {
        console.log("[✓] Tidak ada backup lama yang perlu dihapus.");
        return;
    }

    console.log(`[!] Menemukan folder kedaluwarsa: ${Array.from(foldersToDelete).join(", ")}`);
    console.log(`[!] Menghapus ${objectsToDelete.length} file...`);

    // S3 DeleteObjectsCommand maksimal 1000 objek per request
    for (let i = 0; i < objectsToDelete.length; i += 1000) {
        const chunk = objectsToDelete.slice(i, i + 1000);
        await s3.send(
            new DeleteObjectsCommand({
                Bucket: MINIO_BUCKET,
                Delete: { Objects: chunk },
            })
        );
    }

    console.log("[✓] Backup lama berhasil dibersihkan dari MinIO!");
}

async function run() {
    const folderName = getBackupFolderName();
    const localDir = join(process.cwd(), folderName);

    console.log(`[+] Memulai proses backup ke folder: ${folderName}`);

    // Buat folder lokal
    await Bun.$`mkdir -p ${localDir}`;

    const envVars = { ...process.env, PGPASSWORD: PG_PASSWORD };

    try {
        // 2. Query daftar schema pengguna
        console.log("[+] Mengambil daftar schema...");
        const schemaQuery = `
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog') 
        AND schema_name NOT LIKE 'pg_toast%' 
        AND schema_name NOT LIKE 'pg_temp%';
    `;

        const schemaOutput = await Bun.$`psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${PG_DATABASE} -t -A -c ${schemaQuery}`
            .env(envVars)
            .text();

        const schemas = schemaOutput
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        console.log(`[+] Schema ditemukan: ${schemas.join(", ")}`);

        // 3. Dump per schema
        for (const schema of schemas) {
            const dumpFile = join(localDir, `schema_${schema}.sql.gz`);
            console.log(`[+] Melakukan dump schema: ${schema} -> ${dumpFile}`);
            await Bun.$`pg_dump -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${PG_DATABASE} -n ${schema} | gzip > ${dumpFile}`
                .env(envVars);
        }

        // 4. Dump full database
        const fullDumpFile = join(localDir, `full_database.sql.gz`);
        console.log(`[+] Melakukan dump seluruh database -> ${fullDumpFile}`);
        await Bun.$`pg_dump -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${PG_DATABASE} | gzip > ${fullDumpFile}`
            .env(envVars);

        // 5. Upload ke MinIO (Standard Upload tanpa parameter ObjectLock)
        console.log(`[+] Mengunggah file ke MinIO bucket: ${MINIO_BUCKET}...`);
        const files = await readdir(localDir);

        for (const file of files) {
            const filePath = join(localDir, file);
            const fileBuffer = await readFile(filePath);
            const s3Key = `${folderName}/${file}`;

            console.log(`  -> Mengunggah: ${s3Key}`);
            await s3.send(
                new PutObjectCommand({
                    Bucket: MINIO_BUCKET,
                    Key: s3Key,
                    Body: fileBuffer,
                })
            );
        }

        console.log("[✓] Semua file hari ini berhasil diunggah ke MinIO!");

        // 6. Jalankan pembersihan retensi folder > 7 hari
        await cleanOldBackups();

        // 7. Cleanup folder lokal
        await rm(localDir, { recursive: true, force: true });
        console.log("[✓] Direktori lokal sementara berhasil dibersihkan.");
    } catch (error) {
        console.error("[!] Terjadi kesalahan selama proses backup:", error);
        process.exit(1);
    }
}

run();
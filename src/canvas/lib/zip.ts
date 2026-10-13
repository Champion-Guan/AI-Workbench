import { unzipSync, zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export async function readZip(file: Blob, maxExpandedBytes = 1024 * 1024 * 1024) {
    let total = 0, count = 0;
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
        total += entry.originalSize;
        if (++count > 10000 || total > maxExpandedBytes) throw Error("ZIP 解压内容过大，请分批导入");
        return true;
    } });
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data])]));
}

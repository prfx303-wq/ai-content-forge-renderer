import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const app = express();

app.use(express.json({ limit: "2mb" }));

const port = process.env.PORT || 10000;
const secret = process.env.RENDER_WEBHOOK_SECRET;

app.get("/health", async (_request, response) => {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    response.json({ status: "ok", ffmpeg: true });
  } catch {
    response.status(500).json({ status: "error", ffmpeg: false });
  }
});

app.post("/render", async (request, response) => {
  if (
    secret &&
    request.headers.authorization !== `Bearer ${secret}`
  ) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const {
    jobId,
    title,
    script,
    clipUrls,
    webhookUrl,
    voiceoverUrl,
    subtitleText,
  } = request.body;

  if (
    typeof jobId !== "string" ||
    typeof script !== "string" ||
    !Array.isArray(clipUrls) ||
    typeof webhookUrl !== "string"
  ) {
    return response.status(400).json({
      error: "Payload de rendu invalide",
    });
  }

  response.status(202).json({
    accepted: true,
    jobId,
  });

  void renderVideo({
    jobId,
    title: typeof title === "string" ? title : "AI Content Forge",
    script,
    clipUrls,
    webhookUrl,
    voiceoverUrl,
    subtitleText: subtitleText || script,
  });
});

async function notify(webhookUrl, jobId, payload) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret
        ? { Authorization: `Bearer ${secret}` }
        : {}),
    },
    body: JSON.stringify({
      jobId,
      ...payload,
    }),
  });
}

async function downloadFile(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Téléchargement impossible (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, buffer);
}

async function renderVideo({
  jobId,
  title,
  script,
  clipUrls,
  webhookUrl,
  voiceoverUrl,
  subtitleText,
}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "forge-render-"),
  );

  try {
    await notify(webhookUrl, jobId, {
      status: "rendering",
      progress: 5,
    });

    const selectedClips = clipUrls.slice(0, 6);
    const clipFiles = [];

    for (let index = 0; index < selectedClips.length; index += 1) {
      const file = path.join(directory, `clip-${index}.mp4`);
      await downloadFile(selectedClips[index], file);
      clipFiles.push(file);

      await notify(webhookUrl, jobId, {
        status: "rendering",
        progress: 10 + Math.round(((index + 1) / selectedClips.length) * 35),
      });
    }

    const concatFile = path.join(directory, "concat.txt");

    await fs.writeFile(
      concatFile,
      clipFiles.map((file) => `file '${file}'`).join("\n"),
    );

    const joinedFile = path.join(directory, "joined.mp4");

    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      joinedFile,
    ]);

    await notify(webhookUrl, jobId, {
      status: "rendering",
      progress: 60,
    });

    const subtitleFile = path.join(directory, "subtitles.srt");

    await fs.writeFile(
      subtitleFile,
      `1
00:00:00,000 --> 00:00:08,000
${subtitleText}
`,
    );

    const finalFile = path.join(directory, "final.mp4");

    const inputs = ["-i", joinedFile];

    if (voiceoverUrl) {
      const voiceFile = path.join(directory, "voiceover.mp3");
      await downloadFile(voiceoverUrl, voiceFile);
      inputs.push("-i", voiceFile);
    }

    const audioArguments = voiceoverUrl
      ? [
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-shortest",
        ]
      : ["-an"];

    await execFileAsync("ffmpeg", [
      "-y",
      ...inputs,
      "-vf",
      `subtitles=${subtitleFile}`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      ...audioArguments,
      finalFile,
    ]);

    await notify(webhookUrl, jobId, {
      status: "rendering",
      progress: 90,
    });

    /*
      Pour un premier test, le fichier doit être placé sur un stockage
      public ou un CDN. Cette version utilise une URL fournie par le worker.
      Configure un stockage comme Cloudflare R2 ou S3 pour la production.
    */

    const outputUrl = `${process.env.PUBLIC_OUTPUT_BASE_URL}/${jobId}.mp4`;

    await notify(webhookUrl, jobId, {
      status: "done",
      progress: 100,
      outputUrl,
    });
  } catch (error) {
    await notify(webhookUrl, jobId, {
      status: "failed",
      progress: 0,
      error:
        error instanceof Error
          ? error.message
          : "Le rendu FFmpeg a échoué.",
    });
  } finally {
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FFmpeg worker listening on port ${port}`);
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { site } from "@/lib/site";

export const alt = `${site.name}: ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const asset = (name: string) => readFile(join(process.cwd(), "src", "assets", name));

/** Share image, 1200 x 630. */
export default async function OpenGraphImage() {
  const logoSrc = "data:image/png;base64," + (await readFile(join(process.cwd(), "public", "logo.png"))).toString("base64");
  const [regular, medium, serif] = await Promise.all([
    asset("geist-400.woff"),
    asset("geist-500.woff"),
    asset("instrument-serif-italic.woff"),
  ]);
  const facts = ["Funds stay in your own Safe", "Rules enforced on chain", "A receipt for every dollar"];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#ffffff",
          color: "#0a0a0b",
          fontFamily: "Geist",
          backgroundImage: "radial-gradient(circle at 1px 1px, #dcdce0 1.5px, transparent 0)",
          backgroundSize: "28px 28px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={logoSrc} width={56} height={56} alt="" />
          <div style={{ fontSize: 38, fontWeight: 500, letterSpacing: -1 }}>{site.name}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 104, fontWeight: 500, letterSpacing: -5, lineHeight: 1 }}>
            A bank account
          </div>
          <div style={{ display: "flex", alignItems: "baseline", fontSize: 104, fontWeight: 500, letterSpacing: -5, lineHeight: 1.08 }}>
            for your
            <span style={{ fontFamily: "Instrument Serif", fontStyle: "italic", fontWeight: 400, letterSpacing: -2, marginLeft: 26, fontSize: 116 }}>
              AI agent.
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #cfcfd4",
            paddingTop: 28,
            fontSize: 22,
            color: "#45454d",
          }}
        >
          <div style={{ display: "flex", gap: 30 }}>
            {facts.map((fact) => (
              <div key={fact} style={{ display: "flex" }}>
                {fact}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", color: "#0a0a0b", fontWeight: 500 }}>{site.domain}</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: medium, weight: 500, style: "normal" },
        { name: "Instrument Serif", data: serif, weight: 400, style: "italic" },
      ],
    },
  );
}

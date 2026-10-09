import { ImageResponse } from "next/og";
import { BrandMark } from "@/components/BrandMark";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Carbadia Trade — a carbon credit trading simulator";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #0b1f16 0%, #123527 100%)",
          color: "#f2efe6",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 36, color: "#7fd8a8" }}>
          <BrandMark size={40} />
          <span>Carbadia Trade</span>
        </div>
        <div style={{ display: "flex", fontSize: 84, fontWeight: 700, lineHeight: 1.1, marginTop: 24 }}>
          {"Trade carbon credits like it's real"}
        </div>
        <div style={{ display: "flex", fontSize: 34, color: "#b8c4bb", marginTop: 28 }}>
          $100,000 in demo funds · Order book, OTC, portfolios, simulated retirements · No real money, no real carbon
        </div>
      </div>
    ),
    size
  );
}

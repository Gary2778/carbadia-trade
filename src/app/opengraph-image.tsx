import { ImageResponse } from "next/og";

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
          <svg width="36" height="36" viewBox="0 0 24 24" fill="#7fd8a8">
            <path d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75C7 8 17 8 17 8z" />
          </svg>
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

import { Suspense } from "react";
import { OrderWorkspace } from "@/components/exchange/OrderWorkspace";
export default function OrdersPage() {
  return (
    <Suspense
      fallback={
        <div className="ex-loading" role="status">
          Loading orders…
        </div>
      }
    >
      <OrderWorkspace />
    </Suspense>
  );
}

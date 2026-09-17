export default function Loading() {
  return <div className="stack" aria-busy="true" aria-label="Loading">
    <div className="skeleton" style={{ height: 34, width: "50%" }} />
    <div className="skeleton" style={{ height: 150 }} />
    <div className="skeleton" style={{ height: 96 }} />
    <div className="skeleton" style={{ height: 96 }} />
  </div>;
}

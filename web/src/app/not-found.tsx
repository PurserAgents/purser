import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container center-page">
      <div className="stack" style={{ justifyItems: "center" }}>
        <span className="eyebrow">404</span>
        <h1 className="h1">This page does not exist.</h1>
        <p className="lead">The address may be wrong, or the page has moved.</p>
        <div className="row" style={{ marginTop: 8 }}>
          <Link href="/" className="btn btn--primary">
            Back to the start
          </Link>
          <Link href="/docs" className="btn btn--secondary">
            Read the docs
          </Link>
        </div>
      </div>
    </div>
  );
}

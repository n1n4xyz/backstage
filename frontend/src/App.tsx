import { useCallback, useEffect, useState } from "react";
import {
  CONTRACT_ID,
  CampaignInfo,
  CreatorInfo,
  connectWallet,
  contractLink,
  explainError,
  fromUnits,
  newIdentity,
  readCampaign,
  readCreator,
  send,
  toUnits,
  txLink,
} from "./stellar";

const DEFAULT_CREATOR = "GDSA677ALNKNBSGWL6NW7TBUDKBDVGOLZRPHAPDAR6YC42R7QQGISKDJ";

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "ok"; label: string; hash?: string } | { kind: "err"; label: string };

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export default function App() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [creatorAddr, setCreatorAddr] = useState(() => new URLSearchParams(location.search).get("c") ?? DEFAULT_CREATOR);
  const [creator, setCreator] = useState<CreatorInfo | null>(null);
  const [creatorErr, setCreatorErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const load = useCallback(async () => {
    setCreatorErr(null);
    try {
      setCreator(await readCreator(creatorAddr.trim()));
    } catch (e) {
      setCreator(null);
      setCreatorErr(explainError(e));
    }
  }, [creatorAddr]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(label: string, fn: () => Promise<{ hash: string; value?: unknown }>, done?: (v: unknown) => string) {
    if (!wallet) return setStatus({ kind: "err", label: "Connect Freighter first." });
    setStatus({ kind: "busy", label });
    try {
      const r = await fn();
      setStatus({ kind: "ok", label: done ? done(r.value) : "Done.", hash: r.hash });
      load();
    } catch (e) {
      setStatus({ kind: "err", label: explainError(e) });
    }
  }

  async function connect() {
    try {
      setWallet(await connectWallet());
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "err", label: explainError(e) });
    }
  }

  const isOwnPage = wallet !== null && wallet === creatorAddr.trim();

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>▍</span>Backstage
        </div>
        <span className="net">Testnet</span>
        {wallet ? (
          <span className="wallet mono">{short(wallet)}</span>
        ) : (
          <button className="btn" onClick={connect}>Connect Freighter</button>
        )}
      </header>

      <section className="hero">
        <h1>Back the creators you believe in.<br />Without your name on a list.</h1>
        <p>Tips, memberships and crowdfunding in USDC on Stellar. No platform in the middle. Members prove they belong with a zero-knowledge proof, so nobody learns which fan they are.</p>
      </section>

      <section className="card">
        <label className="lbl" htmlFor="creator">Creator address</label>
        <div className="row">
          <input id="creator" className="input mono" value={creatorAddr} onChange={(e) => setCreatorAddr(e.target.value)} spellCheck={false} />
          <button className="btn ghost" onClick={load}>Load</button>
        </div>
        {creator && (
          <dl className="stats">
            <div><dt>Membership</dt><dd>{fromUnits(creator.price)} USDC</dd></div>
            <div><dt>Members</dt><dd>{creator.member_count}</dd></div>
            <div><dt>Member list</dt><dd>{creator.members_root ? "Published" : "Not yet"}</dd></div>
          </dl>
        )}
        {creatorErr && <p className="muted">{creatorErr}</p>}
      </section>

      {creator && !isOwnPage && (
        <div className="grid">
          <TipCard onTip={(amt) => run("Sending tip…", () => send(wallet!, "tip", { fan: wallet, creator: creatorAddr.trim(), amount: toUnits(amt) }), () => `Tip of ${amt} USDC sent.`)} />
          <JoinCard price={creator.price} onJoin={(commitment) => run("Joining…", () => send(wallet!, "join", { fan: wallet, creator: creatorAddr.trim(), commitment }), (v) => `You are member #${Number(v) + 1}. Keep your secret file safe.`)} />
          <DonateCard onDonate={(id, amt) => run("Donating…", () => send(wallet!, "donate", { fan: wallet, campaign: id, amount: toUnits(amt) }), () => `Donated ${amt} USDC.`)} />
        </div>
      )}

      {wallet && (isOwnPage || creatorErr) && (
        <CreatorStudio
          registered={isOwnPage && creator !== null}
          onRegister={(price) => run("Registering…", () => send(wallet, "register_creator", { creator: wallet, price: toUnits(price) }), () => { setCreatorAddr(wallet); return "You are registered as a creator."; })}
          onCampaign={(goal) => run("Creating campaign…", () => send(wallet, "create_campaign", { creator: wallet, goal: toUnits(goal) }), (v) => `Campaign #${v} created. Share the ID with your fans.`)}
        />
      )}

      <StatusBar status={status} />

      <footer className="foot">
        <a href={contractLink} target="_blank" rel="noreferrer" className="mono">{short(CONTRACT_ID)}</a>
        <span>Fans need a USDC trustline on testnet before they can pay.</span>
      </footer>
    </div>
  );
}

function TipCard({ onTip }: { onTip: (amount: string) => void }) {
  const [amt, setAmt] = useState("2");
  return (
    <section className="card">
      <h2>Tip</h2>
      <p className="muted">Send USDC straight to the creator.</p>
      <div className="row">
        <input className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDC</span>
      </div>
      <button className="btn" onClick={() => onTip(amt)}>Send tip</button>
    </section>
  );
}

function JoinCard({ price, onJoin }: { price: bigint; onJoin: (commitment: Uint8Array) => void }) {
  function join() {
    const { secret, commitment } = newIdentity();
    const blob = new Blob([JSON.stringify({ secret: secret.toString(), contract: CONTRACT_ID, note: "Backstage membership secret. Anyone with this file can prove your membership. Never share it." }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "backstage-membership-secret.json";
    a.click();
    onJoin(commitment);
  }
  return (
    <section className="card accent">
      <h2>Become a member</h2>
      <p className="muted">Your browser creates a secret and downloads it. Only its hash goes on-chain, so your membership stays anonymous.</p>
      <p className="price">{fromUnits(price)} USDC</p>
      <button className="btn" onClick={join}>Join</button>
    </section>
  );
}

function DonateCard({ onDonate }: { onDonate: (id: number, amount: string) => void }) {
  const [id, setId] = useState("0");
  const [amt, setAmt] = useState("10");
  const [info, setInfo] = useState<CampaignInfo | null>(null);
  useEffect(() => {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 0) return setInfo(null);
    readCampaign(n).then(setInfo).catch(() => setInfo(null));
  }, [id]);
  return (
    <section className="card">
      <h2>Crowdfund</h2>
      <p className="muted">Donations and rewards only. No returns.</p>
      <div className="row">
        <input className="input narrow" inputMode="numeric" value={id} onChange={(e) => setId(e.target.value)} aria-label="Campaign ID" />
        <input className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" />
        <span className="unit">USDC</span>
      </div>
      {info && (
        <div className="progress" title={`${fromUnits(info.raised)} of ${fromUnits(info.goal)} USDC`}>
          <div style={{ width: `${Math.min(100, Number((info.raised * 100n) / (info.goal || 1n)))}%` }} />
          <span>{fromUnits(info.raised)} / {fromUnits(info.goal)} USDC{info.open ? "" : " · closed"}</span>
        </div>
      )}
      <button className="btn" onClick={() => onDonate(Number(id), amt)} disabled={!info || !info.open}>Donate</button>
    </section>
  );
}

function CreatorStudio({ registered, onRegister, onCampaign }: { registered: boolean; onRegister: (price: string) => void; onCampaign: (goal: string) => void }) {
  const [price, setPrice] = useState("5");
  const [goal, setGoal] = useState("500");
  return (
    <section className="card studio">
      <h2>Creator studio</h2>
      {!registered ? (
        <>
          <p className="muted">Set your monthly membership price and start receiving support.</p>
          <div className="row">
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <span className="unit">USDC</span>
          </div>
          <button className="btn" onClick={() => onRegister(price)}>Register as creator</button>
        </>
      ) : (
        <>
          <p className="muted">Start a crowdfunding campaign. Donations go straight to your wallet.</p>
          <div className="row">
            <input className="input" inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <span className="unit">USDC goal</span>
          </div>
          <button className="btn" onClick={() => onCampaign(goal)}>Create campaign</button>
        </>
      )}
    </section>
  );
}

function StatusBar({ status }: { status: Status }) {
  if (status.kind === "idle") return null;
  return (
    <div className={`status ${status.kind}`} role="status">
      <span>{status.label}</span>
      {status.kind === "ok" && status.hash && (
        <a href={txLink(status.hash)} target="_blank" rel="noreferrer">View transaction</a>
      )}
    </div>
  );
}

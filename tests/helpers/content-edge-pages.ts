type FixtureNode = { id: string; title: string };

export function contentEdgePageFixture(owner: string, sourceOwner: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const now = Date.now();
  const node: FixtureNode = {
    id: `cn_${crypto.randomUUID()}`,
    title: "Paged relationship owner",
  };
  const targets: FixtureNode[] = [];
  const sources: FixtureNode[] = [];
  const nodeRows: string[] = [];
  const edgeRows: string[] = [];
  const addNode = (entry: FixtureNode, ownerId: string, timestamp: string) => {
    nodeRows.push(
      `(${quote(entry.id)},${quote(ownerId)},'external','public',${quote(`https://example.test/${encodeURIComponent(entry.title)}`)},${quote(entry.title)},${quote(timestamp)},${quote(timestamp)})`,
    );
  };
  // Keep the edited node ahead of its 31 targets in the owner's first page.
  addNode(node, owner, new Date(now).toISOString());
  for (let index = 0; index < 31; index++) {
    const suffix = String(index).padStart(2, "0");
    const timestamp = new Date(now - (31 - index) * 1000).toISOString();
    const target = {
      id: `cn_${crypto.randomUUID()}`,
      title: `Outgoing page target ${suffix}`,
    };
    const source = {
      id: `cn_${crypto.randomUUID()}`,
      title: `Incoming page source ${suffix}`,
    };
    targets.push(target);
    sources.push(source);
    addNode(target, owner, timestamp);
    addNode(source, sourceOwner, timestamp);
    edgeRows.push(
      `(${quote(`ce_${crypto.randomUUID()}`)},${quote(node.id)},${quote(target.id)},'references',${quote(owner)},${quote(timestamp)})`,
      `(${quote(`ce_${crypto.randomUUID()}`)},${quote(source.id)},${quote(node.id)},'references',${quote(sourceOwner)},${quote(timestamp)})`,
    );
  }
  return {
    node,
    targets,
    sources,
    sql: [
      `INSERT INTO content_nodes (id,owner_id,kind,visibility,url,title,created_at,updated_at) VALUES ${nodeRows.join(",")};`,
      `INSERT INTO content_edges (id,source_id,target_id,type,creator_id,created_at) VALUES ${edgeRows.join(",")};`,
    ].join("\n"),
  };
}

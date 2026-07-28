# Learning workflows

Learning Loop keeps Markdown and Properties as the only source of truth. It has
no AI client, prompt history, chat storage, proprietary learning database, or
dependency on another community plugin.

## Vault structure

The initialization command creates missing folders only:

```text
00-Inbox/
10-Topics/
20-Nodes/
30-Sources/{Papers,Books,Documents}/
40-Records/{Experiments,Changes,Incidents}/
50-Assets/{Servers,Services,Databases}/
60-Cards/
70-Maps/
80-Daily/
90-Templates/
99-Attachments/
```

Every managed note has `ll_id`, `ll_type`, `ll_title`, and `ll_created`.
Relationships use stable IDs in `ll_topic`, `ll_parent`, and `ll_related`.
Ordering, current-node state, confidence, verification, mastery, and review
selection are ordinary Properties. The plugin modifies Properties only through
`FileManager.processFrontMatter()`.

## Topics and nodes

**Create topic from Markdown outline** parses headings and task lists while
ignoring fenced examples. It creates one stable Markdown node per item,
preserves hierarchy and task completion, selects the first incomplete node,
and writes a linked learning tree into the topic.

Node commands create inline questions, promote a question, move to another
parent or the topic root, reorder siblings, split selected material, merge
without deleting the source note, append timestamped corrections, select the
current node, set confidence, mark verification, add to review, and mark
mastery. Cycle checks prevent a node from becoming its own descendant.

Each node contains:

```text
当前理解
为什么
边界条件
示例
实验或证据
容易混淆
待探索
相关知识
来源
修正记录
```

## English, papers, and operations

English-term notes include technical and cross-domain meanings, original and
cloze sentences, examples, a user-authored sentence, and confusing words. A
new term also creates an English review card.

Paper notes include metadata, research question, method, experiments, results,
author claims, limitations, original text, translation, user understanding,
questions, and distilled nodes. A paper or incident can be distilled into a
node while retaining a source link.

Operations commands create server, service, database, change, incident, and
runbook notes. Their templates include prechecks, rollback, health or recovery
verification, and post-incident knowledge extraction as appropriate. A
conservative scanner rejects likely private-key blocks, bearer credentials,
access keys, and password/token assignments. Markdown should contain only a
password-manager or SecretStorage reference.

## Review scheduling

Cards support exactly these types:

```text
定义 原理 比较 步骤 诊断 代码预测 英文术语 论文结论
```

The only grades are `不会`, `模糊`, and `掌握`. The deterministic scheduler
stores `ll_due`, `ll_interval`, `ll_ease`, `ll_repetitions`,
`ll_last_reviewed`, and `ll_last_grade` in the card's Properties. An interval
is capped at ten years and ease remains between 1.3 and 3.0. The daily
dashboard is a normal Markdown file with the current node and all due-card
links.

## Maps

For each topic, the generator creates deterministic structure, relation,
mobile-path, and focused Canvas files from node Properties. Current nodes are
highlighted, ordering is stable, duplicate relation edges are removed, and
large desktop maps collapse after a bounded node count with a visible
placeholder. The mobile path contains ancestors, siblings, and children around
the current node.

`Thinking.canvas` is created once and never overwritten. Automatic map names
are the only files the generator updates. Deleting an automatic Canvas triggers
reconstruction from Markdown; deleting or editing the manual thinking map does
not.

## Mobile entry points

The single-column mobile panel exposes today's review, continue current node,
quick question, record term, append one understanding, current topic path,
runbook, unlock, foreground sync, and lock. These are lightweight views over
the same Markdown data used on desktop.

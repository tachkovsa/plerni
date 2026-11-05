# Maintainer approval-signing key

The approval-artifact gate checks a detached signature on gate-config changes. The signature is made with the maintainer's private key. The matching public key is the single line in [`scripts/gates/approvals/maintainer.pub`](../../scripts/gates/approvals/maintainer.pub). That file is public. It cannot sign anything.

This guide is how the maintainer backs up that private key, rotates the public key, treats approvals signed with the previous key, and responds when the private key is compromised. It describes the verifier that is in the repository today. It does not change the verifier.

The key is only for this gate. Tenant document signing uses different keys, kept in the secret store ([ADR-0011](../adr/0011-digest-signing-port.md)). Rotating one does not rotate the other.

Issue [#62](https://github.com/tachkovsa/plerni/issues/62) is the checklist for this guide. Task K10 in [`docs/plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) asks for it.

## Back up the private key

Make the backup before you need it. The copy in git is the public key only.

Keep the private key in a store the maintainer controls, outside this repository:

- A password manager that can hold the OpenSSH private-key file and its passphrase. Keep a second copy in a different store the maintainer controls, so one lost device does not become a lost key.
- A hardware security key. The command below, with `-t ed25519-sk`, creates a key the verifier accepts. Accepted types are `ssh-ed25519`, `ssh-rsa`, `ssh-ecdsa`, `ssh-ecdsa-sk`, and `ssh-ed25519-sk`. The device holds a private key that cannot be exported. The file ssh-keygen writes beside it is a key handle, and signing needs both the file and the same device. Put that key-handle file in the password manager. Losing the device means the key is lost. A second device produces a new key pair. It is a new public key, and it follows the rotation steps. This guide keeps the key handle off the device (OpenSSH's `-O resident` stores the handle on the device as well).

Generate the key from a directory that is not the clone, so the private key file never lands in the worktree. Pass `-f`. Without it, ssh-keygen offers a default filename in the SSH directory and can overwrite an existing login key. Set a passphrase when asked, and store it with the private key.

Software key:

```sh
ssh-keygen -t ed25519 -f plerni-maintainer-signing-key -C plerni-gate-approval
```

Hardware key, with the authenticator attached (touch it when asked):

```sh
ssh-keygen -t ed25519-sk -f plerni-maintainer-signing-key -C plerni-gate-approval
```

The file `plerni-maintainer-signing-key` is the private key (or the key handle). `plerni-maintainer-signing-key.pub` is the public line. If `git status` inside the clone lists either name, you ran this in the worktree. Remove both files from the clone and generate them again outside it.

Confirm the backup before you trust it. On a machine that does not already have the working copy, restore `plerni-maintainer-signing-key` into a directory outside the clone and run:

```sh
ssh-keygen -y -f plerni-maintainer-signing-key
printf '%s' 'backup check' > throwaway.txt
printf 'maintainer %s\n' "$(ssh-keygen -y -f plerni-maintainer-signing-key)" > allowed
ssh-keygen -Y sign -f plerni-maintainer-signing-key -n plerni-gate-approval throwaway.txt
ssh-keygen -Y verify -f allowed -I maintainer -n plerni-gate-approval -s throwaway.txt.sig < throwaway.txt
```

The `ssh-keygen -y` line must match `scripts/gates/approvals/maintainer.pub` exactly, including the comment when the file has one. The committed key is an `ssh-ed25519` line with the comment `plerni-gate-approval`. The `allowed` file is the one-line allowed-signers record the verifier builds: the word `maintainer`, a space, and that public-key line. A successful verify prints `Good "plerni-gate-approval" signature for maintainer`. Delete `throwaway.txt`, `throwaway.txt.sig`, `allowed`, and the restored private key from a machine that should not hold them.

The private key stays out of the repository, pull requests, issues, commit messages, and chat. An agent does not read it. AGENTS.md §0 covers that rule: private keys are never committed, and a key that reaches history is rotated and then the history is rewritten.

## Rotate the key

Rotation replaces `scripts/gates/approvals/maintainer.pub` with a new public key. The change is a gate-config change. The waiver in [`docs/ai/model-routing.md`](../ai/model-routing.md) does not cover it.

### How the rotation pull request gets approved

The check would be pointless if a pull request could replace the public key and sign with the new key. The workflow [`.github/workflows/approval-artifact.yml`](../../.github/workflows/approval-artifact.yml) avoids that:

- On a pull request it runs `pull_request_target`. The workflow file and [`scripts/gates/verify-approval.mjs`](../../scripts/gates/verify-approval.mjs) come from the base branch. The job fetches the pull request head only to diff it. The pull request cannot delete the check or swap the script.
- The verifier reads `maintainer.pub` from the merge-base of the base branch and the pull request head. The merge-base is the latest commit that is on both. The verifier never reads the public key from the pull request head.
- The base argument is the 40-character commit SHA. A branch name is rejected.
- A missing public key at that commit fails closed. There is no fallback to the key on the head.
- The signature namespace is `plerni-gate-approval`. The signer identity is `maintainer`.

So the rotation pull request is signed with the current private key, the one that matches the public key already on the base. A signature from the new key fails, including when the new public key is in the same pull request. The same check runs on a push to `dev`, against the previous commit's public key. Pushing the new key straight to `dev` is not a way around the signature.

While the waiver sentence is on the base ("The signed approval artifact for gate-config changes is waived at the current stage"), a missing artifact is allowed for other scoped edits. It is not allowed when `maintainer.pub` changes. The job then fails with `approval key changed; the waiver does not cover a key rotation`. An artifact that is present is still checked. A bad signature still fails.

The P0 plan §8 also asks for a human review receipt on a rotation, together with the incumbent signature. Record that receipt on the pull request. Name the head SHA. A later push needs a new receipt. Receipt fields are in [`docs/ai/model-routing.md`](../ai/model-routing.md).

### Steps

Do this only when you still have the current private key, and you have no reason to think anyone else has it. If the key is compromised, follow [If the key is compromised](#if-the-key-is-compromised) as well. The steps below still apply, and the overlap window does not.

1. Generate the new pair with the backup steps above. Store the new private key and confirm you can read it back before you destroy anything old.
2. In the directory outside the clone, print the new public key and copy that single line into `scripts/gates/approvals/maintainer.pub`:

   ```sh
   ssh-keygen -y -f plerni-maintainer-signing-key
   ```

   A trailing newline in the repo file is accepted. A second line fails the format check and the job fails closed (`approval key at the base commit is not a public key`). The file holds the new public key alone. The verifier today accepts one key.
3. Commit only that file:

   ```sh
   git add scripts/gates/approvals/maintainer.pub
   git commit -m "ci: rotate maintainer approval public key"
   ```

   The scope digest is `git diff` between two commits. Uncommitted edits are outside it. The digest covers `.github/workflows/`, `scripts/gates/` (the public key stays in the digest), `tools/harness/sql/`, and `tools/spikes/*/bench/.artifacts/`. It excludes `scripts/gates/approvals/*.json` and `scripts/gates/approvals/*.json.sig`. Keep every other scoped path unchanged in this pull request, so the signature means this key change and nothing else.
4. Fetch `dev` and print the scope digest. `BASE` is the 40-character SHA, not a branch name.

   ```sh
   git fetch origin dev
   BASE=$(git merge-base origin/dev HEAD)
   node scripts/gates/verify-approval.mjs --base "$BASE" --head HEAD --print-scope
   ```

   Use this command. A hand-rolled `git diff` follows local diff settings and produces a different digest, which the verifier rejects.

5. Write the artifact as exactly these bytes: UTF-8, one line, keys in this order, no trailing newline.

   ```text
   {"approver":"maintainer","scope_sha256":"<64 lowercase hex digits>","timestamp":"<UTC timestamp>"}
   ```

   `approver` is the word `maintainer`. The digest is the hex line from the previous step. The timestamp is UTC, as in `2026-11-05T00:00:00Z`: non-empty, at most 80 characters, and free of control characters. Path: `scripts/gates/approvals/YYYY-MM-DD-maintainer-key-rotation.json`. Replace `DIGEST` and `TIMESTAMP`, then write the bytes with no trailing newline:

   ```sh
   printf '%s' '{"approver":"maintainer","scope_sha256":"DIGEST","timestamp":"TIMESTAMP"}' > scripts/gates/approvals/YYYY-MM-DD-maintainer-key-rotation.json
   ```

6. From the repository root, sign that file with the current private key (the key that matches the public key on the base). Set `SIGNING_KEY` in this shell to that private key file outside the clone. Do not write the assignment into a file in the repository. A relative `-f plerni-maintainer-signing-key` from the repository root would look inside the worktree.

   ```sh
   ssh-keygen -Y sign -f "$SIGNING_KEY" -n plerni-gate-approval -s scripts/gates/approvals/YYYY-MM-DD-maintainer-key-rotation.json.sig scripts/gates/approvals/YYYY-MM-DD-maintainer-key-rotation.json
   ```

7. Commit the `.json` and `.json.sig` files on their own:

   ```sh
   git add scripts/gates/approvals/YYYY-MM-DD-maintainer-key-rotation.json scripts/gates/approvals/YYYY-MM-DD-maintainer-key-rotation.json.sig
   git commit -m "ci: sign maintainer approval key rotation"
   ```

   Those two files are outside the digest, so this commit leaves the digest unchanged. Run `--print-scope` again. The hex must be identical. If it differs, a scoped file or the base moved; recompute, rewrite the artifact, and sign again. Editing the JSON after signing invalidates the signature.
8. Run the verifier on the same two commits:

   ```sh
   node scripts/gates/verify-approval.mjs --base "$BASE" --head HEAD
   ```

   Success prints `verify-approval: OK` and the scope hex. Then open the pull request. Review the diff as a press release: the public key line changes, and the two artifact files are added. No private-key file, no passphrase, no second public key.
9. After it merges, sign later artifacts with the new private key. Before you delete the old private key, confirm `ssh-keygen -y -f "$SIGNING_KEY"` on the new private key matches the merged `maintainer.pub`, and that the backup check's verify command succeeds for the new key. On a planned rotation you may keep the old private key until the next real artifact signed with the new key has passed the verifier. On a compromise, delete the old private key as soon as that backup check succeeds and the new public key is on `dev`. Retire a hardware device that held the old key.

If you amend the public key or any other scoped file, the digest changes. Re-run from step 4 before you push.

### If the private key is lost

Loss means you cannot produce a signature and you have no reason to think anyone else has the key. You cannot finish the steps above. Signing with the new key does not help: the verifier ignores the public key on the head. Adding the waiver sentence on the head does not help: the waiver is read from the base, and it does not cover a key change. Editing the workflow on the head does not help: the job runs the workflow from the base.

Recovery is a maintainer action on the repository, the same shape as key genesis in the P0 plan §8. Genesis was the one public-key change with no incumbent signature; it carried a human review receipt instead. A lost key is that shape again.

1. Open a pull request whose only change is the new `scripts/gates/approvals/maintainer.pub`. The `approval-artifact` check fails closed. That failure is expected. Leave it red.
2. Put a human review receipt on the pull request. Name the head SHA. State that the private key is lost, that there is no incumbent signature, and that the diff is only the new public key.
3. With no other pull request open that touches `.github/workflows/`, `scripts/gates/`, `tools/harness/sql/`, or `tools/spikes/*/bench/.artifacts/`, lift the required `approval-artifact` check on `dev`, merge this pull request only, and restore the required check before any other merge. While the check is not required, a different change in those paths could merge with no valid signature. The push of that merge to `dev` runs the same verifier and fails closed, because the public key changed and there is no incumbent signature. That red run is the record of this recovery. It does not remove the commit. The next pull request reads the new public key from the base.
4. Store the new private key with the backup steps. The next gate-config change is signed with it, against the new public key on the base.

This is not the path for a key that may have been copied. Use the compromise steps, which add a review of open pull requests and of recent merges.

## Approvals signed with the old key

The verifier checks artifacts that the pull request under review adds, edits, renames, or deletes. It does not re-check artifacts already on the base branch. An approval that merged under the old key stays in history as the record of that merge. Replacing `maintainer.pub` leaves that record in place.

An open pull request is different. Its merge-base still points at the old public key until the branch is rebased onto a `dev` that contains the new key. Until that rebase, an artifact signed with the old key still verifies. After the rebase, the base key is the new key, the old signature fails, and you recompute the digest and sign with the new private key.

### One key today

`verify-approval.mjs` loads one public-key line from `maintainer.pub` at the base commit and gives that single line to `ssh-keygen -Y verify`. A signature from any other key fails. Two lines in the file fail the format check. A planned rotation therefore cuts over at merge. Do not rely on a period when both keys work. Do not append the old public key to the file.

### Overlap the design requires later

Task K10 and §10.2 question 7 of the P1 kernel design require a later verifier to accept a set of public keys during a named window, and to fail closed for a key removed after that window. This guide names the window. The verifier in the repository does not implement it. Landing that set is a later change to the gate, signed like any other change to `maintainer.pub`, and it is outside this document.

**Overlap window for a planned rotation of a key that is not compromised: 14 days**, counted from the committer timestamp of the merge commit on `dev` that publishes the new public key.

- During those 14 days the future verifier accepts an artifact signed by the outgoing public key or by the new public key.
- When the window ends, the outgoing public key is removed from the set. A new artifact signed by it fails closed. Artifacts that already merged are still not re-checked.
- The maintainer may end the window sooner by removing the outgoing key from the set. The window is not extended past 14 days.
- Until that verifier is on `dev`, ignore this window and follow [One key today](#one-key-today). Re-sign any pull request you rebase across the rotation.

A compromised key does not get these 14 days.

## If the key is compromised

Compromise means someone else may have the private key, or you cannot rule that out. A valid signature then shows possession of the key. It does not show that the maintainer intended the change. Treat every not-yet-merged artifact signed with that key as untrusted.

The overlap window does not apply. The old public key is removed in the rotation itself, with no period where the verifier still accepts it.

1. Close open pull requests you did not sign that touch `.github/workflows/`, `scripts/gates/`, `tools/harness/sql/`, `tools/spikes/*/bench/.artifacts/`, or `scripts/gates/approvals/`. A stolen key can sign a matching artifact for a hostile diff.
2. If you still have the private key, rotate with the steps in [Rotate the key](#rotate-the-key). The rotation diff is only the new public key and the artifact pair signed by the current key. Review it yourself. Overlap is zero.
3. If you no longer have the private key, use [If the private key is lost](#if-the-private-key-is-lost) to publish the new public key, and still do the review in the next step. Assume the old key can sign until the new public key is on `dev` and `approval-artifact` is required again.
4. Review merges to `dev` since the earliest time the key could have left your control, on those same paths. The verifier will not re-check them. Revert a merged change you do not trust in a follow-up pull request, signed with the new key after the rotation has merged. Keep that revert out of the rotation pull request so the rotation signature covers only the new public key.
5. After the new key is on `dev` and a signature from it has passed the verifier, delete every copy of the old private key: password-manager items, key-handle files, and any export. A backup of a compromised key is still the compromised key. Retire a hardware device that held it.
6. If the private key itself reached a commit, follow AGENTS.md §0 as well: rotate first, then rewrite history. This guide does not replace that rule.

Merging to `dev` also takes permission on the repository. Key rotation does not recover a stolen account that can merge on its own. That is a separate maintainer response; close or revert the merges, then rotate this key.

## Sources

Behavior of the gate: [`scripts/gates/verify-approval.mjs`](../../scripts/gates/verify-approval.mjs), [`.github/workflows/approval-artifact.yml`](../../.github/workflows/approval-artifact.yml), and the P0 plan §8 in [`docs/plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md). The waiver sentence is the owner decision of 2026-10-15 in [`docs/ai/model-routing.md`](../ai/model-routing.md). The overlap requirement is §10.2 question 7 and task K10 of [`docs/plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md). Task K10's acceptance line cites §6. Section 6 of that design is contract versioning and does not state this key's rules. The window length is the one named above.

OpenSSH commands follow `ssh-keygen(1)` ([man.openbsd.org/ssh-keygen](https://man.openbsd.org/ssh-keygen.1), read 2026-11-05): `-t ed25519` and `-t ed25519-sk`, `-y`, `-Y sign` with `-f` and `-n`, and the allowed-signers file used by `-Y verify`. The `-s` path on `-Y sign` is the form the repository's approval tests use; the manual's default is to write `file.sig` beside the file. FIDO notes in that manual: the device key is not exportable, signing needs the on-disk key handle and the same authenticator, and resident keys store the handle on the device.

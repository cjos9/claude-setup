import test from "node:test";
import assert from "node:assert/strict";
import { assessCommand, nativeDir, splitCommands, tokenize } from "../scripts/lib/push-rules.mjs";

const on = (branch) => ({ branchOf: () => branch });

// Records every directory whose branch is looked up; each lookup answers `branch`.
function dirsSeen(command, branch = "feat/x") {
  const seen = [];
  const reason = assessCommand(command, { branchOf: (dir) => { seen.push(dir); return branch; } });
  return { seen, reason };
}

test("tokenize handles quotes", () => {
  assert.deepEqual(tokenize(`git commit -m "fix: a b" 'c d'`), ["git", "commit", "-m", "fix: a b", "c d"]);
});

test("tokenize joins quoted parts of one word and drops stray quotes", () => {
  assert.deepEqual(tokenize(`GIT_SSH_COMMAND="ssh -v" git`), ["GIT_SSH_COMMAND=ssh -v", "git"]);
  assert.deepEqual(tokenize(`git push origin main"`), ["git", "push", "origin", "main"]);
  assert.deepEqual(tokenize(`'cd x`), ["cd", "x"]);
});

test("splitCommands splits bash and PowerShell chains", () => {
  assert.deepEqual(splitCommands("npm test && git push; echo ok | cat"), ["npm test", "git push", "echo ok", "cat"]);
});

test("plain push from a feature branch passes", () => {
  assert.equal(assessCommand("git push", on("feat/x")), null);
  assert.equal(assessCommand("git push -u origin HEAD", on("feat/x")), null);
  assert.equal(assessCommand("git push origin feat/x", on("feat/x")), null);
});

test("plain push from main or master asks", () => {
  assert.match(assessCommand("git push", on("main")), /main/);
  assert.match(assessCommand("git push origin", on("master")), /master/);
  assert.match(assessCommand("git push -u origin HEAD", on("main")), /main/);
});

test("detached HEAD with a plain push passes", () => {
  assert.equal(assessCommand("git push", on("")), null);
});

test("a branch that cannot be determined asks when the push depends on it", () => {
  for (const command of ["git push", "git push origin", "git push -u origin HEAD", "git push origin @"]) {
    assert.match(assessCommand(command, on(null)), /could not be determined/, command);
  }
  assert.equal(assessCommand("git push origin feat/x", on(null)), null);
});

test("an explicit protected target asks from any branch", () => {
  assert.match(assessCommand("git push origin main", on("feat/x")), /main/);
  assert.match(assessCommand("git push origin feat/x:main", on("feat/x")), /main/);
  assert.match(assessCommand("git push origin HEAD:refs/heads/master", on("feat/x")), /master/);
});

test("tags ask", () => {
  for (const command of ["git push --tags", "git push --follow-tags", "git push origin v1.2.0", "git push origin refs/tags/v1"]) {
    assert.ok(assessCommand(command, on("feat/x")), command);
  }
});

test("force, mirror, all and delete ask", () => {
  for (const command of [
    "git push -f",
    "git push --force-with-lease=feat/x",
    "git push origin +feat/x",
    "git push --mirror",
    "git push --all",
    "git push origin --delete feat/x",
    "git push origin :feat/x",
  ]) {
    assert.ok(assessCommand(command, on("feat/x")), command);
  }
});

test("git -C uses that directory's branch", () => {
  const seen = [];
  const reason = assessCommand(`git -C "C:\\Users\\me\\repo" push`, { branchOf: (dir) => { seen.push(dir); return "main"; } });
  assert.match(reason, /main/);
  assert.deepEqual(seen, ["C:\\Users\\me\\repo"]);
});

test("cd before the push changes the directory", () => {
  const seen = [];
  assessCommand("cd sub && git push", { branchOf: (dir) => { seen.push(dir); return "feat/x"; } });
  assert.deepEqual(seen, ["sub"]);
});

test("a push hidden in a chain is found", () => {
  assert.match(assessCommand("npm test && git push origin main", on("feat/x")), /main/);
  assert.match(assessCommand("cd C:\\repo; git push origin main", on("feat/x")), /main/);
});

test("gh merges and releases ask, other gh commands pass", () => {
  assert.match(assessCommand("gh pr merge 12 --squash", on("feat/x")), /merge/);
  assert.match(assessCommand("gh release create v1.0.0", on("feat/x")), /release/);
  assert.match(assessCommand("gh repo edit --visibility public", on("feat/x")), /repo edit/);
  assert.equal(assessCommand("gh pr create --fill", on("feat/x")), null);
  assert.equal(assessCommand("gh pr view", on("main")), null);
});

test("unrelated commands pass", () => {
  for (const command of ["git status", "git commit -m 'push to main later'", "dotnet test", "echo git push origin main"]) {
    assert.equal(assessCommand(command, on("main")), null, command);
  }
});

test("shell redirections do not defeat protected-branch check", () => {
  assert.match(assessCommand("git push origin 2>&1", on("main")), /main/);
  assert.match(assessCommand("git push 2>/dev/null", on("main")), /main/);
  assert.match(assessCommand("git push origin > push.log 2>&1", on("main")), /main/);
  assert.match(assessCommand("git push origin &>log", on("main")), /main/);
  assert.equal(assessCommand("git push -u origin HEAD 2>&1", on("feat/x")), null);
});

test("subshells are assessed", () => {
  const seen = [];
  assessCommand("(cd sub && git push)", { branchOf: (dir) => { seen.push(dir); return "feat/x"; } });
  assert.deepEqual(seen, ["sub"]);
  assert.match(assessCommand("(git push origin main)", on("feat/x")), /main/);
});

test("redirection operators: consuming operators consume filename token", () => {
  const consumingOps = [">", ">>", "<", "<<", "&>", "&>>", "2>", "2>>", "0<"];
  for (const op of consumingOps) {
    // On main: git push origin OP file.txt should ask (file.txt consumed, no refspec, so check current branch)
    assert.match(assessCommand(`git push origin ${op} file.txt`, on("main")), /main/, `${op} on main`);
    // On feat/x: git push origin OP file.txt main should ask (file.txt consumed, main is refspec)
    assert.match(assessCommand(`git push origin ${op} file.txt main`, on("feat/x")), /main/, `${op} with refspec on feat/x`);
    // On feat/x: git push origin OP file.txt should pass (file.txt consumed, no refspec, not protected)
    assert.equal(assessCommand(`git push origin ${op} file.txt`, on("feat/x")), null, `${op} no refspec on feat/x`);
  }
});

test("redirection operators: self-contained redirections don't consume next token", () => {
  const selfContained = ["2>&1", "1>&2", ">&2", "&>&2", ">out.txt", "2>/dev/null", "&>log", "<in.txt"];
  for (const token of selfContained) {
    // On feat/x: git push origin T main should ask (T is self-contained, main is refspec)
    assert.match(assessCommand(`git push origin ${token} main`, on("feat/x")), /main/, `${token} with refspec on feat/x`);
    // On feat/x: git push origin T should pass (T is self-contained, no refspec, not protected)
    assert.equal(assessCommand(`git push origin ${token}`, on("feat/x")), null, `${token} no refspec on feat/x`);
    // On main: git push origin T should ask (T is self-contained, no refspec, but on protected branch)
    assert.match(assessCommand(`git push origin ${token}`, on("main")), /main/, `${token} on main`);
  }
});

test("fd-duplication redirections don't consume following refspecs", () => {
  assert.match(assessCommand("git push origin 2>&1 main", on("feat/x")), /main/);
  assert.match(assessCommand("git push 1>&2 origin main", on("feat/x")), /main/);
  assert.match(assessCommand("git push origin >&2 main", on("feat/x")), /main/);
  assert.match(assessCommand("git push origin > log.txt main", on("feat/x")), /main/);
});

test("successive cd targets compose; absolute targets replace", () => {
  assert.deepEqual(dirsSeen("cd a && cd b && git push").seen, ["a/b"]);
  assert.deepEqual(dirsSeen("cd a && cd C:\\repo && git push").seen, ["C:\\repo"]);
  assert.deepEqual(dirsSeen("cd /c/repo && cd ../other && git push").seen, ["/c/repo/../other"]);
  assert.deepEqual(dirsSeen("cd ~ && cd repo && git push").seen, ["~/repo"]);
  assert.deepEqual(dirsSeen("cd a && git -C b push").seen, ["a/b"]);
  assert.deepEqual(dirsSeen("cd /c/Users/me/repo && git push").seen, ["/c/Users/me/repo"]);
  assert.deepEqual(dirsSeen("git -C /c/Users/me/repo push").seen, ["/c/Users/me/repo"]);
});

test("Push-Location, Set-Location and the location stack are followed", () => {
  assert.deepEqual(dirsSeen("Push-Location C:\\repo; git push").seen, ["C:\\repo"]);
  assert.deepEqual(dirsSeen("Set-Location -Path C:\\repo; git push").seen, ["C:\\repo"]);
  assert.deepEqual(dirsSeen("Push-Location C:\\repo; Pop-Location; git push").seen, [null]);
  assert.deepEqual(dirsSeen("pushd a && popd && git push").seen, [null]);
  assert.match(dirsSeen("Push-Location C:\\repo; git push", "main").reason, /main/);
});

test("a directory that cannot be followed asks instead of guessing", () => {
  for (const command of ["cd - && git push", "popd && git push", "Pop-Location; git push -u origin HEAD"]) {
    const { seen, reason } = dirsSeen(command);
    assert.match(reason, /could not be determined/, command);
    assert.deepEqual(seen, [], command);
  }
});

test("a cd inside a subshell does not leak out of it", () => {
  assert.deepEqual(dirsSeen("(cd other && ls) && git push").seen, [null]);
});

const WRAPPED_PUSHES = [
  "GIT_TRACE=1 git push origin main",
  `GIT_SSH_COMMAND="ssh -v" git push origin main`,
  "env git push origin main",
  "env GIT_TRACE=1 git push origin main",
  "command git push origin main",
  "timeout 60 git push origin main",
  "nohup git push origin main",
  "time git push origin main",
  "sudo git push origin main",
  "& git push origin main",
  `& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main`,
  `"C:\\Program Files\\Git\\cmd\\git.exe" push origin main`,
  "/usr/bin/git push origin main",
  "GIT.EXE push origin main",
  `bash -c "git push origin main"`,
  `bash -lc 'cd x && git push origin main'`,
  `sh -c "git push origin main"`,
  `pwsh -Command "git push origin main"`,
  `powershell -Command "git push origin main"`,
  `powershell -NoProfile -Command "git push origin main"`,
  "wsl -d Dev -- git push origin main",
  `wsl -d Dev -- bash -lc "cd /mnt/c/x && git push origin main"`,
  `if ($ok) { git push origin main }`,
  `if true; then git push origin main; fi`,
  `cmd /c "git push origin main"`,
];

test("prefixed and wrapped pushes to main ask", () => {
  for (const command of WRAPPED_PUSHES) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /main/, command);
  }
});

test("the same wrappers pushing a feature branch pass", () => {
  for (const command of WRAPPED_PUSHES.map((c) => c.replace("origin main", "origin feat/x"))) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("wrapped gh merges ask", () => {
  assert.match(assessCommand(`bash -c "gh pr merge 12 --squash"`, on("feat/x")), /merge/);
  assert.match(assessCommand("env GH_TOKEN=x gh release create v1", on("feat/x")), /release/);
});

test("a cd inside a wrapped command string decides the branch", () => {
  // Only the named directory is on main; everything else (including the cwd) is a feature branch.
  const mainAt = (dir) => ({ branchOf: (seen) => (seen === dir ? "main" : "feat/x") });
  assert.match(assessCommand(`bash -lc 'cd /c/other && git push'`, mainAt("/c/other")) ?? "", /main/);
  assert.match(assessCommand(`cd a && bash -c "cd b && git push"`, mainAt("a/b")) ?? "", /main/);
  assert.match(assessCommand(`wsl -- bash -lc "cd /mnt/c/x && git push"`, mainAt("C:/x")) ?? "", /main/);
  assert.match(assessCommand(`wsl --cd /mnt/d/y -- git push`, mainAt("D:/y")) ?? "", /main/);
  assert.equal(assessCommand(`bash -lc 'cd /c/other && git push'`, mainAt("/c/elsewhere")), null);
  assert.match(dirsSeen(`wsl -- bash -lc "cd /home/me/x && git push"`).reason ?? "", /could not be determined/);
});

test("parentheses scope a cd in bash but not in PowerShell", () => {
  const seen = [];
  const branchOf = (dir) => { seen.push(dir); return "feat/x"; };
  assessCommand("(Set-Location C:\\repo); git push", { branchOf, shell: "powershell" });
  assessCommand("(cd C:\\repo); git push", { branchOf, shell: "bash" });
  assert.deepEqual(seen, ["C:\\repo", null]);
});

test("{ } groups are unwrapped", () => {
  assert.match(assessCommand("{ git push origin }", on("main")), /main/);
});

test("nativeDir maps Git Bash paths and ~ on Windows", () => {
  const options = {
    platform: "win32",
    home: "C:\\Users\\me",
    cygpath: (dir) => (dir === "/tmp/x" ? "C:\\Users\\me\\AppData\\Local\\Temp\\x" : null),
  };
  assert.equal(nativeDir("/c/Users/me/repo", options), "C:/Users/me/repo");
  assert.equal(nativeDir("/d", options), "D:/");
  assert.equal(nativeDir("/tmp/x", options), "C:\\Users\\me\\AppData\\Local\\Temp\\x");
  assert.equal(nativeDir("/opt/unknown", options), null);
  assert.equal(nativeDir("~", options), "C:\\Users\\me");
  assert.equal(nativeDir("~/repo", options), "C:\\Users\\me/repo");
  assert.equal(nativeDir("C:\\repo", options), "C:\\repo");
  assert.equal(nativeDir("sub/dir", options), "sub/dir");
  assert.equal(nativeDir("/c/repo", { platform: "linux", home: "/home/me" }), "/c/repo");
  assert.equal(nativeDir("~/repo", { platform: "linux", home: "/home/me" }), "/home/me/repo");
});

test("a push through --git-dir or GIT_DIR asks, because the cwd's branch says nothing about that repo", () => {
  for (const command of [
    "git --git-dir=C:/other/.git push",
    "git --git-dir C:/other/.git push origin HEAD",
    "git --work-tree=C:/other push",
    "GIT_DIR=C:/other/.git git push",
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /could not be determined/, command);
  }
  assert.equal(assessCommand("git --git-dir=C:/other/.git push origin feat/x", on("feat/x")), null);
});

test("a command after a lone background & is still assessed", () => {
  for (const command of ["sleep 1 & git push origin main", "sleep 1 &git push origin main", `cmd /c "echo x & git push origin main"`]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /main/, command);
  }
  assert.match(assessCommand("git push origin main 2>&1 | tee log", on("feat/x")) ?? "", /main/);
  assert.equal(assessCommand("git push origin feat/x &> log", on("feat/x")), null);
});

test("powershell -EncodedCommand is decoded and assessed", () => {
  const encoded = Buffer.from("git push origin main", "utf16le").toString("base64");
  assert.match(assessCommand(`powershell -NoProfile -EncodedCommand ${encoded}`, on("feat/x")) ?? "", /main/);
  assert.match(assessCommand(`pwsh -enc ${encoded}`, on("feat/x")) ?? "", /main/);
  const harmless = Buffer.from("Get-Date", "utf16le").toString("base64");
  assert.equal(assessCommand(`powershell -EncodedCommand ${harmless}`, on("feat/x")), null);
});

test("gh api calls that merge or publish ask; reads pass", () => {
  for (const command of [
    "gh api -X PUT repos/o/r/pulls/5/merge",
    "gh api --method=PUT repos/o/r/pulls/5/merge -f merge_method=squash",
    "gh api repos/o/r/pulls/5/merge -f merge_method=squash",
    "gh api -X POST repos/o/r/merges -f base=main -f head=feat",
    "gh api -X POST repos/o/r/releases -f tag_name=v1",
    "gh api --method DELETE /repos/o/r/releases/12",
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /gh api/, command);
  }
  for (const command of ["gh api repos/o/r/pulls/5", "gh api repos/o/r/releases", "gh api -X GET repos/o/r/pulls/5/merge"]) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("merge messages name no project", () => {
  for (const command of ["gh pr merge 5", "gh api -X PUT repos/o/r/pulls/5/merge", "glab mr merge 5", "glab api -X PUT projects/1/merge_requests/5/merge", "git push -o merge_request.auto_merge"]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /may deploy/, command);
  }
});

const withDefault = (branch, defaultBranch) => ({ branchOf: () => branch, defaultBranchOf: () => defaultBranch });

test("the remote's default branch is protected like main, whatever its name", () => {
  assert.match(assessCommand("git push", withDefault("develop", "develop")) ?? "", /develop/);
  assert.match(assessCommand("git push origin develop", withDefault("feat/x", "develop")) ?? "", /develop/);
  assert.match(assessCommand("git push origin HEAD:refs/heads/develop", withDefault("feat/x", "develop")) ?? "", /develop/);
  assert.equal(assessCommand("git push", withDefault("feat/x", "develop")), null);
  assert.match(assessCommand("git push", withDefault("main", "develop")) ?? "", /main/, "main and master stay protected");
  assert.equal(assessCommand("git push", withDefault("develop", null)), null, "an unknown default branch adds nothing");
});

test("the default branch is looked up for the pushed remote", () => {
  const seen = [];
  const options = { branchOf: () => "feat/x", defaultBranchOf: (dir, remote) => { seen.push(remote); return null; } };
  for (const command of ["git push upstream", "git push", "git push https://example.com/x.git feat/x"]) assessCommand(command, options);
  assert.deepEqual(seen, ["upstream", "origin", "origin"]);
});

test("push options that merge automatically ask; other push options pass", () => {
  for (const command of [
    "git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds",
    "git push -u origin HEAD -o merge_request.auto_merge",
    "git push --push-option=merge_request.merge_when_pipeline_succeeds",
    "git push --push-option merge_request.auto_merge origin feat/x",
    "git push -omerge_request.auto_merge",
    `bash -c "git push -o merge_request.auto_merge"`,
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /merges automatically/, command);
  }
  for (const command of [
    "git push -u origin HEAD -o merge_request.create -o merge_request.target=main",
    `git push -o "merge_request.title=feat: x" -o ci.skip`,
  ]) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("glab merges, releases, repository changes and pipelines ask; other glab commands pass", () => {
  for (const command of [
    "glab mr merge 12", "glab mr accept 12 --squash", "glab release create v1.0.0", "glab release delete v1",
    "glab release upload v1 a.zip", "glab repo delete group/app", "glab repo transfer group/app --target-namespace other",
    "glab ci trigger 123", "glab ci run -b main",
  ]) {
    assert.ok(assessCommand(command, on("feat/x")), command);
  }
  for (const command of ["glab mr create --fill --yes", "glab mr view", "glab ci status", "glab repo view", "glab release list"]) {
    assert.equal(assessCommand(command, on("main")), null, command);
  }
});

test("gh workflow run asks, other gh workflow commands pass", () => {
  assert.match(assessCommand("gh workflow run deploy.yml", on("feat/x")) ?? "", /workflow/);
  assert.equal(assessCommand("gh workflow list", on("feat/x")), null);
});

test("glab api calls that merge or publish ask; reads pass", () => {
  for (const command of [
    "glab api -X PUT projects/42/merge_requests/5/merge",
    "glab api --method POST projects/group%2Fapp/releases -f tag_name=v1",
    "glab api projects/42/repository/tags -f tag_name=v1 -f ref=main",
    "glab api -X POST projects/42/jobs/77/play",
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /glab api/, command);
  }
  for (const command of ["glab api projects/42/merge_requests/5", "glab api projects/42/releases"]) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("a value option before the endpoint does not hide a merge", () => {
  assert.match(assessCommand(`gh api -H "Accept: application/json" -X PUT repos/o/r/pulls/5/merge`, on("feat/x")) ?? "", /gh api/);
  assert.match(assessCommand(`glab api --header "X: y" -X PUT projects/1/merge_requests/2/merge`, on("feat/x")) ?? "", /glab api/);
  assert.match(assessCommand(`gh api --hostname github.example.com -X PUT repos/o/r/pulls/5/merge`, on("feat/x")) ?? "", /gh api/);
});

test("auto-merge push options ask in every form git accepts", () => {
  for (const command of [
    "git -c push.pushOption=merge_request.auto_merge push origin feat/x",
    "git -c PUSH.PUSHOPTION=merge_request.merge_when_pipeline_succeeds push",
    "git push -uo merge_request.auto_merge origin feat/x",
    "git push -uomerge_request.auto_merge origin feat/x",
    "git push --push-o=merge_request.auto_merge",
    "git push --push-opt merge_request.auto_merge origin feat/x",
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /merges automatically/, command);
  }
  assert.equal(assessCommand("git push -uo merge_request.create origin feat/x", on("feat/x")), null, "the option value is not the remote");
  assert.equal(assessCommand("git -c push.pushOption=ci.skip push", on("feat/x")), null);
});

test("bundled short flags and abbreviated long flags are read like git reads them", () => {
  for (const command of ["git push -uf origin feat/x", "git push -fu", "git push --forc", "git push --tag", "git push --mirr", "git push origin --delet feat/x"]) {
    assert.ok(assessCommand(command, on("feat/x")), command);
  }
  for (const command of ["git push -u origin feat/x", "git push -uv origin feat/x", "git push --set-up origin feat/x", "git push --no-verify"]) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("glab auto-merge and command aliases ask", () => {
  for (const command of [
    "glab mr create --fill --auto-merge --yes", "glab mr new --auto-merge", "glab mr update 3 --auto-merge",
    "glab ci create -b main", "glab pipeline run", "glab pipe trigger 5",
    "glab project delete group/app", "glab project transfer group/app", "glab project update group/app",
  ]) {
    assert.ok(assessCommand(command, on("feat/x")), command);
  }
  assert.equal(assessCommand("glab mr create --fill --yes --auto-merge=false", on("feat/x")), null);
  assert.equal(assessCommand("glab pipeline status", on("feat/x")), null);
  assert.equal(assessCommand("glab project view", on("feat/x")), null);
});

test("an api call that merges asks whatever value options come before the endpoint", () => {
  assert.match(assessCommand("glab api --output json -X PUT projects/1/merge_requests/2/merge", on("feat/x")) ?? "", /glab api/);
  assert.match(assessCommand("glab api --form tag_name=v1 projects/1/releases", on("feat/x")) ?? "", /glab api/);
  assert.match(assessCommand("glab api --form=tag_name=v1 projects/1/releases", on("feat/x")) ?? "", /glab api/);
  assert.match(assessCommand("gh api --unknown-option value -X PUT repos/o/r/pulls/5/merge", on("feat/x")) ?? "", /gh api/);
});

test("wrapped glab merges ask", () => {
  assert.match(assessCommand(`bash -c "glab mr merge 3"`, on("feat/x")) ?? "", /merge/);
  assert.match(assessCommand("wsl -- glab mr merge 3", on("feat/x")) ?? "", /merge/);
  assert.match(assessCommand("env GITLAB_TOKEN=x glab release create v1", on("feat/x")) ?? "", /release/);
});

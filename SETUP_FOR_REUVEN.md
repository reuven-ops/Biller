# Setup for Reuven

Plain-language steps. Total hands-on time across the build: roughly two to three hours spread over seven weeks. Everything else is Claude Code's job.

## Before the build starts (30 minutes)

1. Create an Anthropic API key at console.anthropic.com with billing enabled. This is the one outside service the tool uses. Keep the key in a password manager.
2. Make sure your Claude Code subscription is active on the machine you will build from. Your Windows PC is fine.
3. Create a folder named cm-coding-advisor. Put CLAUDE.md in the folder and BRIEF.md inside a docs subfolder.
4. Open a terminal in that folder, start Claude Code, and paste the kickoff message from the top of docs/BRIEF.md.
5. When Claude Code asks for the API key, give it. It will store the key in a local .env file that is never committed.

Claude Code will now work through Phases 0 to 2 (the library couriers and the answer engine) and report at the end of each phase. Read the reports. Redirect if something looks off.

## Around week 4 (45 minutes)

Claude Code will ask for four things before Phase 4. Have them ready:

1. Jeremy's list of payers ranked by claim volume, down to 80 percent of claims.
2. The list of states and Medicare contractors your clients bill under.
3. The client list, and which billers serve which clients. This controls who can see which contracts.
4. A de-identified export of claim lines from the RCM data warehouse in the column layout in Appendix B of the brief. No patient names, birth dates, or member IDs in the file. If the warehouse team needs the spec, send them Appendix B.

## Around week 5: the server (30 minutes)

The tool needs one Linux machine that ClinicMind controls. Options in order of preference:

1. A virtual machine in the cloud account ClinicMind already uses for CM 2.0, sized 4 CPUs, 16 GB memory, 200 GB disk, Ubuntu 24.04.
2. A virtual machine from any major provider with the same size.

Ask whoever manages ClinicMind infrastructure (Erez's team) for:

1. The machine, with Docker installed and SSH access for the deploy step.
2. A hostname billers will type, either internal (advisor.clinicmind.internal) or public (advisor.clinicmind.com). Internal is preferred; public needs the firewall to allow only ClinicMind addresses.
3. A place for nightly backups: a second disk, a file share, or storage in the same cloud account.
4. Outbound access from the server to the domains listed in config/egress.yaml. Everything else can stay blocked.

Give Claude Code the SSH details and the hostname. It handles the rest of Phase 5 and tests a backup restore.

## Week 7: day one (1 hour)

1. Send Claude Code the names and emails of the pilot users: you, Jeremy, the lead coder, and three billers.
2. Have the lead coder work through the 28 golden questions in Appendix A and record a verdict on each. Claude Code stores the verdicts.
3. Pilot for five business days. Billers press Correct, Incorrect, or Partial on every answer. Review the Incorrect ones with the lead coder at the end of the week.
4. Roll out to the full RCM team using the checklist Claude Code writes in docs/RUNBOOK.md.

## In parallel, on your own timeline

1. Call AMA licensing about AI use of CPT under ClinicMind's existing license. Until that is signed, the tool shows CPT codes by number only and abstains on questions that depend on CPT descriptors or CPT time ranges not restated in a CMS source. It is usable without it; it is better with it.
2. If you ever want billers to paste chart text, get a BAA on the Anthropic account first, then flip PHI_MODE to allow.

## What you will pay (hypothesis)

1. Anthropic usage: pennies per question. At 100 questions a day, about $300 a month. A daily cap in the settings stops runaway spend.
2. The server: whatever a 4 CPU, 16 GB virtual machine costs in your cloud account.
3. Claude Code: your existing subscription during the build and whenever you want changes later.
4. No other subscriptions.

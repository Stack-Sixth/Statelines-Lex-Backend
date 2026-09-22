# Push to Stack-Sixth/Statelines-Lex-Backend

The backend folder is ready to place in your repository. These instructions do not push anything until you run the final command.

## Recommended: clone the organisation repository first

Open Terminal:

```bash
cd ~/Documents
git clone git@github.com:Stack-Sixth/Statelines-Lex-Backend.git
cd Statelines-Lex-Backend
```

If SSH authentication is not configured, use this clone command instead:

```bash
git clone https://github.com/Stack-Sixth/Statelines-Lex-Backend.git
```

Authenticate through GitHub's supported credential flow. Your normal GitHub account password is not a Git HTTPS credential.

Copy the contents of the supplied backend folder into the cloned repository. On this Mac, this command copies source/configuration while excluding generated files and secrets:

```bash
rsync -av \
  --exclude='node_modules' --exclude='dist' --exclude='.git' \
  --exclude='.env' --exclude='.env.local' \
  '/Users/mac/Documents/Codex/2026-09-16/i-have-been-working-on-the/outputs/statelines-lex-backend/' \
  ./
```

If the organisation repository already contains backend source, inspect it first; this copy can replace files with the same names. Prefer a review branch for an existing repository.

For an empty repository:

```bash
git branch -M main
git add .
git status
git diff --cached --stat
git commit -m "Build LEX transactional shipment API and delivery worker"
git push -u origin main
```

For a repository with existing commits or protected main:

```bash
git switch -c codex/lex-backend
git add .
git status
git diff --cached --stat
git commit -m "Build LEX transactional shipment API and delivery worker"
git push -u origin codex/lex-backend
```

Then open a pull request on GitHub and merge after CI succeeds. If push is rejected, do not force-push: check branch protections, organisation permissions, or remote changes.

Before committing, confirm `.env`, passwords and tokens are absent from `git status`. `.env.example` contains placeholders and belongs in Git. If Git asks for your identity, configure your own name and verified email; no identity has been invented for you.

Next: [Deploy on Render](DEPLOY.md).

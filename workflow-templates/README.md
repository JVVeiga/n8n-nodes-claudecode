# 🚀 Claude Code n8n Workflow Templates

Ready-to-use workflow templates that showcase the power of Claude Code in n8n automation.

## 📦 Available Templates

### 1. 🐛 [Automatic Bug Fixer](./automatic-bug-fixer.json)
**Trigger**: GitHub Issue webhook  
**What it does**: 
- Analyzes bug reports from GitHub issues
- Searches codebase for the root cause
- Generates and tests a fix
- Creates a pull request with the solution
- Comments on the issue with the fix details

**Perfect for**: Teams wanting to automate bug fixes for common issues

**Worth adding when your reports carry files**: this template feeds Claude the issue text only. If
the bug reports come from a tracker that attaches evidence — a screenshot of the broken screen, a CSV
of the failing rows, an HTML capture — set **Binary Properties** (or **Attach All Binaries**) on the
Claude Code node and the files reach the model with the prompt. Images go in as images, so it can
read a screenshot. See [Attachments](../README.md#attachments).

---

### 2. 📚 [Documentation Generator](./codebase-documentation-generator.json)
**Trigger**: Weekly schedule  
**What it does**:
- Scans entire codebase for changes
- Updates API documentation
- Creates architecture diagrams
- Generates setup guides
- Builds documentation site

**Perfect for**: Keeping documentation always up-to-date

---

### 3. 🎫 [Customer Support Automation](./customer-support-automation.json)
**Trigger**: Support ticket webhook  
**What it does**:
- Analyzes customer bug reports
- Reproduces and diagnoses issues
- Generates fixes with tests
- Provides immediate workarounds to customers
- Creates PRs for permanent fixes
- Updates support tickets automatically

**Perfect for**: Reducing support response time from days to minutes

---

### 4. ⛽ [Plan Limit Guard](./plan-limit-guard.json)
**Trigger**: Schedule, every 30 minutes  
**What it does**:
- Reads the account's remaining Claude plan capacity with the **Claude Code Usage** node — free, no
  tokens spent
- Alerts when the read comes back with no numbers, instead of mistaking that for an unlimited plan
- Alerts Slack with the window, the percentage and the reset time when utilisation reaches 85%
- Runs the agent work only while there is capacity left

**Perfect for**: Keeping scheduled agent workflows from piling into a rate limit, and knowing when
capacity comes back

> This is the only template that does not need a webhook. It is also the one to copy the *shape* of:
> put a usage read in front of anything that fans out into several Claude Code nodes.

## 🛠️ How to Use These Templates

### Method 1: Import via n8n UI
1. Download the desired `.json` file
2. In n8n, click **Workflows** → **Add Workflow** → **Import from File**
3. Select the downloaded template
4. Update the configuration:
   - Set your `projectPath`
   - Configure webhooks/triggers
   - Update credentials (GitHub, Slack, etc.)

### Method 2: Copy & Paste
1. Open the `.json` file
2. Copy the entire content
3. In n8n, create a new workflow
4. Press `Ctrl+V` (or `Cmd+V` on Mac) to paste

## ⚙️ Configuration Required

### Common Settings to Update

1. **Project Path**: 
   ```javascript
   "projectPath": "/path/to/your/project"  // Update this!
   ```

2. **Webhook URLs**: Each webhook needs a unique path
   ```javascript
   "path": "webhook/your-unique-path"
   ```

3. **External Services**:
   - GitHub: Repository owner and name
   - Slack: Channel names and authentication
   - Email: SMTP settings or service credentials
   - Databases: Connection strings

4. **Plan Limit Guard only**: the 85% threshold and the schedule interval
   ```javascript
   "rightValue": 85              // Alert threshold, 0-100
   "minutesInterval": 30         // How often to check
   ```
   Both Slack nodes post to `#engineering-alerts` — change the channel, and note that the guard
   needs no webhook or Project Path of its own (the gated Claude Code node still does).

### Required Credentials

Most templates need these credentials configured in n8n:
- **GitHub**: Personal access token with repo permissions
- **Slack**: Bot token or webhook URL
- **Email**: SMTP or service-specific credentials
- **Databases**: Connection credentials

## 🎯 Tips for Success

### 1. Start Simple
- Test with a single workflow first
- Use manual triggers for testing
- Monitor execution logs

### 2. Customize Prompts
Each template's prompts can be customized:
```javascript
"prompt": "Your custom instructions here"
```

### 3. Adjust Timeouts
For complex operations, increase timeouts:
```javascript
"timeout": 600  // 10 minutes
```

### 4. Control Tool Access
Limit tools for safety:
```javascript
"allowedTools": ["Read", "Grep"]  // Read-only access
```

## 📝 Creating Your Own Templates

### Template Structure
```json
{
  "name": "Your Workflow Name",
  "nodes": [...],
  "connections": {...},
  "settings": {"executionOrder": "v1"},
  "meta": {"templateId": "unique-id"}
}
```

### Best Practices
1. **Clear Naming**: Use descriptive node names
2. **Error Handling**: Add IF nodes for error cases
3. **Notifications**: Always notify on completion/failure
4. **Documentation**: Add sticky notes explaining complex logic
5. **Testing**: Include test data in pinData for easy testing

## 🚨 Common Issues & Solutions

### "Claude Code not found"
Make sure Claude Code CLI is installed on your n8n server:
```bash
npm install -g @anthropic-ai/claude-code
claude auth
```

### "Webhook not receiving data"
- Check webhook URL is accessible
- Verify webhook path is unique
- Test with tools like `curl` or Postman

### "Timeout errors"
- Increase the timeout value
- Use Sonnet model for faster responses
- Break complex operations into steps

## 🤝 Contributing

Have a great workflow template? We'd love to include it!

1. Create your workflow in n8n
2. Export it as JSON
3. Add clear documentation
4. Submit a PR to this repository

## 📚 Learn More

- [Claude Code Documentation](https://docs.anthropic.com/claude-code)
- [n8n Documentation](https://docs.n8n.io)
- [Main README](../README.md)

---

**Questions?** Open an issue in our [GitHub repository](https://github.com/holt-web-ai/n8n-nodes-claudecode/issues)!
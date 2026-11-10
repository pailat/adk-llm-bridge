# Basic Agent with Anthropic (Claude)

## What it shows

A multi-agent HelpDesk system using [Anthropic](https://anthropic.com/) Claude as the LLM provider.

## Requirements

- Bun and Node.js 22 or newer.
- `ANTHROPIC_API_KEY`

## Architecture

```mermaid
graph TD
    User([User]) --> Coordinator[HelpDeskCoordinator]
    Coordinator --> Billing[Billing Agent]
    Coordinator --> Support[Support Agent]
    
    Billing --> T1[check_invoice]
    Billing --> T2[process_refund]
    
    Support --> T3[check_system_status]
    Support --> T4[reset_password]
```

## Run

1. Copy the environment file and add your Anthropic API key:
   ```bash
   cp .env.example .env
   # Edit .env and add your ANTHROPIC_API_KEY
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Run the agent with DevTools:
   ```bash
   bun run web
   ```

## Supported Models

- `claude-sonnet-5-5` (default)
- `claude-fable-5-1`
- `claude-opus-5-5`
- `claude-haiku-5-5`

To change the model, edit `agent.ts` and update the `model` property.

## Example Questions

### Billing Agent
- "Can you check the status of invoice INV-001?"
- "I need to request a refund for invoice INV-002"
- "What invoices do I have for user@example.com?"

### Support Agent
- "What's the current status of the auth service?"
- "I need to reset my password for user@example.com"
- "Is the API experiencing any issues?"

### Coordinator
- "I have a billing question about my subscription"
- "I can't log into my account"

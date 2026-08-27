use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use relayflowd::{Engine, RunStatus, engine::read_spec, server};

#[derive(Debug, Parser)]
#[command(
    name = "relayflowd",
    version,
    about = "Relayflow durable execution kernel"
)]
struct Cli {
    #[arg(long, global = true, default_value = ".relayflowd")]
    data_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start and execute a run spec JSON file.
    Run {
        spec: PathBuf,
        #[arg(long, default_value = "cli")]
        created_by: String,
        /// Test/debug boundary: return after this many newly completed steps.
        #[arg(long, hide = true)]
        stop_after: Option<usize>,
    },
    /// Resume a run from its durable journal.
    Resume {
        run_id: String,
        #[arg(long, hide = true)]
        stop_after: Option<usize>,
    },
    /// Serve journal protocol v0 over a Unix socket.
    Serve,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let engine = Engine::new(&cli.data_dir);
    match cli.command {
        Command::Run {
            spec,
            created_by,
            stop_after,
        } => {
            let outcome = engine.start(read_spec(&spec)?, &created_by, stop_after)?;
            println!("{}", serde_json::to_string(&outcome)?);
            if outcome.status == RunStatus::Failed {
                bail!("run {} failed", outcome.run_id);
            }
        }
        Command::Resume { run_id, stop_after } => {
            let outcome = engine.resume(&run_id, stop_after)?;
            println!("{}", serde_json::to_string(&outcome)?);
            if outcome.status == RunStatus::Failed {
                bail!("run {} failed", outcome.run_id);
            }
        }
        Command::Serve => server::serve(&cli.data_dir)?,
    }
    Ok(())
}

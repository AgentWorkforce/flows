use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use relayflowd::{DriveOptions, Engine, RunStatus, engine::read_spec, server};

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
        /// Test/debug boundary: pause before the named runnable step.
        #[arg(long, hide = true)]
        pause_before_step: Option<String>,
        /// Test/debug boundary: pause after all steps, before run completion.
        #[arg(long, hide = true)]
        pause_before_completion: bool,
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
            pause_before_step,
            pause_before_completion,
        } => {
            let outcome = engine.start_with_options(
                read_spec(&spec)?,
                &created_by,
                DriveOptions {
                    stop_after,
                    pause_before_step,
                    pause_before_completion,
                },
            )?;
            println!("{}", serde_json::to_string(&outcome)?);
            if outcome.status == RunStatus::Failed {
                bail!("run {} failed", outcome.run_id);
            }
        }
        Command::Resume { run_id, stop_after } => {
            let outcome = if stop_after.is_none() {
                if let Some(outcome) = server::resume_via_socket(&cli.data_dir, &run_id)? {
                    outcome
                } else {
                    engine.resume(&run_id, None)?
                }
            } else {
                engine.resume(&run_id, stop_after)?
            };
            println!("{}", serde_json::to_string(&outcome)?);
            if outcome.status == RunStatus::Failed {
                bail!("run {} failed", outcome.run_id);
            }
        }
        Command::Serve => server::serve(&cli.data_dir)?,
    }
    Ok(())
}

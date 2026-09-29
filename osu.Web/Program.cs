// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// See the LICENCE file in the repository root for full licence text.

using System;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Threading;
using System.Threading.Tasks;
using osu.Framework;
using osu.Framework.Logging;
using osu.Framework.Platform;
using osu.Framework.Platform.Web;
using osu.Game.Rulesets.Catch;
using osu.Game.Rulesets.Mania;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Taiko;

namespace osu.Web
{
    [SupportedOSPlatform("browser")]
    public static partial class Program
    {
        private const string game_name = @"osu";

        [JSImport("globalThis.osuweb.audioGetSampleRate")]
        private static partial int getSampleRate();

        public static Task Main(string[] args)
        {
            // Main() runs on the browser's main (UI) thread, which must never block, and is the only thread that can query the page directly.
            int sampleRate = getSampleRate();

            // The game runs on its own worker, which owns the WebGL context. It must be a JSWebWorker: its frame loop returns to the
            // worker's JS event loop between frames, which the browser needs to release per-frame resources created on that thread.
            // The runtime exits once Main completes, so this completes only when the game does.
            return runOnJSWebWorker(() => runGame(sampleRate));
        }

        private static async Task runGame(int sampleRate)
        {
            Thread.CurrentThread.Name = "osu! (game)";

            // This is a safe default. Localised usages should specify lower values as required.
            AppDomain.CurrentDomain.SetData("REGEX_DEFAULT_MATCH_TIMEOUT", TimeSpan.FromMilliseconds(1000));

            // There are no ruleset assemblies on "disk" to be discovered, so make sure the built-in rulesets are loaded into the AppDomain.
            ensureLoaded(typeof(OsuRuleset), typeof(TaikoRuleset), typeof(CatchRuleset), typeof(ManiaRuleset));

            // Mirror log output to the browser console.
            Logger.NewEntry += entry =>
            {
                if (entry.Level < LogLevel.Verbose)
                    return;

                string message = $"[{entry.Target?.ToString().ToLowerInvariant() ?? entry.LoggerName}] {entry.Message}";
                if (entry.Exception != null)
                    message += $"\n{entry.Exception}";

                if (entry.Level == LogLevel.Error)
                    Console.Error.WriteLine(message);
                else
                    Console.WriteLine(message);
            };

            try
            {
                using (var host = new WebGameHost(game_name, sampleRate, new HostOptions { FriendlyGameName = "osu!" }))
                    await host.RunAsync(new OsuGameWeb());
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"osu! crashed: {e}");
                Logger.Error(e, "osu! crashed");
            }
        }

        /// <summary>
        /// Runs <paramref name="body"/> on a new thread with its own JS event loop.
        /// </summary>
        /// <remarks>
        /// .NET's JSWebWorker is not part of the public API surface yet.
        /// </remarks>
        [DynamicDependency(DynamicallyAccessedMemberTypes.PublicMethods | DynamicallyAccessedMemberTypes.NonPublicMethods,
            "System.Runtime.InteropServices.JavaScript.JSWebWorker", "System.Runtime.InteropServices.JavaScript")]
        private static Task runOnJSWebWorker(Func<Task> body)
        {
            var type = typeof(JSHost).Assembly.GetType("System.Runtime.InteropServices.JavaScript.JSWebWorker", throwOnError: true)!;
            var method = type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                             .Where(m => m.Name == "RunAsync" && !m.IsGenericMethod && m.GetParameters() is var p && p.Length >= 1 && p[0].ParameterType == typeof(Func<Task>))
                             .OrderBy(m => m.GetParameters().Length)
                             .First();

            object?[] arguments = method.GetParameters().Select((p, i) => i == 0 ? body : p.HasDefaultValue ? p.DefaultValue : (p.ParameterType == typeof(CancellationToken) ? CancellationToken.None : null)).ToArray();

            var task = (Task)method.Invoke(null, arguments)!;
            task.ContinueWith(t => Console.Error.WriteLine($"osu! game worker failed: {t.Exception}"), TaskContinuationOptions.OnlyOnFaulted);
            return task;
        }

        private static void ensureLoaded(params Type[] types)
        {
            foreach (var t in types)
                Console.WriteLine($"Loaded ruleset assembly {t.Assembly.GetName().Name}");
        }
    }
}

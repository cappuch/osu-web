// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// See the LICENCE file in the repository root for full licence text.

using osu.Game;
using osu.Game.Updater;

namespace osu.Web
{
    /// <summary>
    /// osu! running in a web browser.
    /// </summary>
    public partial class OsuGameWeb : OsuGame
    {
        public OsuGameWeb()
            : base(null)
        {
        }

        // Updates are delivered by reloading the page.
        protected override UpdateManager CreateUpdateManager() => new NoActionUpdateManager();
    }
}

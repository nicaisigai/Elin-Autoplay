using System;
using System.Linq;
using BepInEx;
using HarmonyLib;

namespace ElinGmFix
{
    /// <summary>
    /// Guards two Elin methods that can throw every frame after zones are entered programmatically:
    ///  - BaseGameScreen.RefreshWeather: Point.map / pc.pos go out of sync during Scene.Init and
    ///    "pc.pos.cell.room" throws IndexOutOfRange, aborting the whole scene init (blank screen).
    ///  - Chara.SyncRide (both overloads): a parasite / mount left behind in another zone still gets
    ///    moved into the current map every Tick, and its out-of-bounds position throws IndexOutOfRange.
    /// Both are purely cosmetic / self-healing failures, so dropping the exception is safe.
    /// </summary>
    [BepInPlugin("elin.gmfix.weather", "Elin GM Fix", "0.2.0")]
    public class GmFixMod : BaseUnityPlugin
    {
        void Awake()
        {
            var harmony = new Harmony("elin.gmfix.weather");
            harmony.PatchAll(typeof(WeatherPatch));
            harmony.PatchAll(typeof(SyncRideNoArgPatch));
            harmony.PatchAll(typeof(SyncRideArgPatch));

            var patched = Harmony.GetAllPatchedMethods()
                .Where(m => m.DeclaringType == typeof(BaseGameScreen) || m.DeclaringType == typeof(Chara))
                .Select(m => m.DeclaringType.Name + "." + m.Name + "(" + string.Join(",", m.GetParameters().Select(p => p.ParameterType.Name).ToArray()) + ")")
                .ToList();
            Logger.LogInfo("ElinGmFix active, guarded: " + string.Join(" | ", patched.ToArray()));
        }
    }

    [HarmonyPatch(typeof(BaseGameScreen), "RefreshWeather")]
    public static class WeatherPatch
    {
        static Exception Finalizer(Exception __exception)
        {
            return null;
        }
    }

    [HarmonyPatch(typeof(Chara), "SyncRide", new Type[] { })]
    public static class SyncRideNoArgPatch
    {
        static Exception Finalizer(Exception __exception)
        {
            return null;
        }
    }

    [HarmonyPatch(typeof(Chara), "SyncRide", new Type[] { typeof(Chara) })]
    public static class SyncRideArgPatch
    {
        static Exception Finalizer(Exception __exception)
        {
            return null;
        }
    }
}

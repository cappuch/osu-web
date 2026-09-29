// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// See the LICENCE file in the repository root for full licence text.

// Rewrites P/Invoke declarations which pass structs by value so they can be used on .NET's WebAssembly runtime.
//
// The .NET WebAssembly build generates a static P/Invoke table at build time and doesn't support by-value struct parameters.
// On wasm32 (Emscripten's C ABI), non-scalar aggregates passed by value are passed indirectly - as a pointer to a copy - so
// declaring the parameter as `ref T` on the managed side is ABI-compatible with the native `T value` parameter.
//
// For each affected P/Invoke `static extern R M(A a, T value, ...)` this:
//   - renames the extern to `M__byref` and changes the struct parameter(s) to `ref T`,
//   - adds a managed `static R M(A a, T value, ...)` shim with the original signature that forwards the address of its argument,
// so no call sites need to change.
//
// usage: PInvokePatcher <input.dll> <output.dll> [search directories...]

using Mono.Cecil;
using Mono.Cecil.Cil;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: PInvokePatcher <input.dll> <output.dll> [search dirs...]");
    return 1;
}

string input = args[0];
string output = args[1];

var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(input))!);
foreach (string dir in args.Skip(2))
    resolver.AddSearchDirectory(dir);

using var assembly = AssemblyDefinition.ReadAssembly(input, new ReaderParameters { AssemblyResolver = resolver, ReadWrite = false, InMemory = true });

int patched = 0;

foreach (var type in assembly.MainModule.GetTypes().ToArray())
{
    foreach (var method in type.Methods.ToArray())
    {
        if (!method.IsPInvokeImpl || method.PInvokeInfo == null)
            continue;

        var structParams = method.Parameters.Where(isByValueStruct).ToArray();
        if (structParams.Length == 0)
            continue;

        // Create the shim with the original signature.
        var shim = new MethodDefinition(method.Name, method.Attributes & ~(MethodAttributes.PInvokeImpl), method.ReturnType)
        {
            ImplAttributes = MethodImplAttributes.IL | MethodImplAttributes.Managed | MethodImplAttributes.AggressiveInlining,
        };

        foreach (var p in method.Parameters)
        {
            var copy = new ParameterDefinition(p.Name, p.Attributes & ~ParameterAttributes.HasFieldMarshal, p.ParameterType);
            shim.Parameters.Add(copy);
        }

        // Existing call instructions reference this MethodDefinition by metadata token, not by name. Retarget them to the
        // shim before renaming the extern; otherwise they would call the new by-ref signature with the old by-value IL.
        foreach (var callerType in assembly.MainModule.GetTypes())
        {
            foreach (var caller in callerType.Methods.Where(m => m.HasBody))
            {
                foreach (var instruction in caller.Body.Instructions)
                {
                    if (instruction.Operand is not MethodReference reference
                        || reference.Module != method.Module
                        || reference.Name != method.Name
                        || reference.DeclaringType.FullName != method.DeclaringType.FullName)
                        continue;

                    if (reference.Resolve() == method)
                        instruction.Operand = shim;
                }
            }
        }

        // Convert the extern.
        if (method.PInvokeInfo.EntryPoint == null || method.PInvokeInfo.EntryPoint == method.Name)
            method.PInvokeInfo.EntryPoint = method.Name;
        method.Name += "__byref";
        method.IsPublic = false;
        method.IsPrivate = true;

        foreach (var p in structParams)
            p.ParameterType = new ByReferenceType(p.ParameterType);

        var il = shim.Body.GetILProcessor();

        foreach (var p in shim.Parameters)
        {
            if (isByValueStruct(p))
                il.Emit(OpCodes.Ldarga, p);
            else
                il.Emit(OpCodes.Ldarg, p);
        }

        il.Emit(OpCodes.Call, method);
        il.Emit(OpCodes.Ret);

        type.Methods.Add(shim);
        patched++;

        Console.WriteLine($"  patched {type.FullName}::{shim.Name} ({string.Join(", ", structParams.Select(p => p.ParameterType.GetElementType().Name))})");
    }
}

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
assembly.Write(output);
Console.WriteLine($"PInvokePatcher: {patched} P/Invoke(s) patched in {Path.GetFileName(input)} -> {output}");
return 0;

static bool isByValueStruct(ParameterDefinition p)
{
    var t = p.ParameterType;
    if (t.IsByReference || t.IsPointer || t.IsArray || t.IsGenericParameter || !t.IsValueType)
        return false;

    if (t.IsPrimitive || t.MetadataType == MetadataType.IntPtr || t.MetadataType == MetadataType.UIntPtr)
        return false;

    var def = t.Resolve();
    if (def == null || def.IsEnum)
        return false;

    // Single-scalar structs are passed as the scalar on wasm32, so only patch structs which contain more than one field.
    var fields = def.Fields.Where(f => !f.IsStatic).ToArray();
    if (fields.Length == 1 && (fields[0].FieldType.IsPrimitive || fields[0].FieldType.MetadataType == MetadataType.IntPtr))
        return false;

    return true;
}

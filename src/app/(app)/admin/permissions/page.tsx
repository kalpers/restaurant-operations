import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { listPermissions } from "@/modules/auth/services/role-service";

export default async function PermissionsPage() {
  await requirePagePermission("admin.roles.view");
  const permissions = await listPermissions(getDatabase());
  const categories = [...new Set(permissions.map((item) => item.category))];

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Permissions</h1>
      <div className="grid gap-6">
        {categories.map((category) => (
          <section key={category}>
            <h2 className="mb-2 font-semibold">{category}</h2>
            <ul className="grid gap-1 sm:grid-cols-2">
              {permissions
                .filter((item) => item.category === category)
                .map((item) => (
                  <li key={item.code}>
                    {item.name}{" "}
                    <code className="text-sm text-neutral-600">{item.code}</code>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

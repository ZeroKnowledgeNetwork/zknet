import { useRef } from "react";
import { Link } from "react-router";
import { IconBars3, IconCog, IconGlobe } from ".";
import { useStore } from "../store";

export function Header() {
  const drawerRef = useRef<HTMLInputElement>(null);

  const setMessage = useStore((s) => s.setMessage);

  const closeDrawer = () => {
    if (drawerRef.current) {
      drawerRef.current.checked = false;
    }
  };

  const handleLink = () => {
    closeDrawer();
    setMessage("info", ""); // clear any messages
  };

  // SideBar nav item
  const NavItem = ({
    to,
    icon,
    label,
  }: {
    to: string;
    icon: JSX.Element;
    label: string;
  }) => (
    <li>
      <Link to={to} onClick={handleLink}>
        <span className="text-primary">{icon}</span>
        {label}
      </Link>
    </li>
  );

  // https://v5.daisyui.com/components/drawer/#drawer-that-opens-from-right-side-of-page
  const SideBar = () => (
    <div className="drawer">
      <input
        id="my-drawer"
        type="checkbox"
        className="drawer-toggle"
        ref={drawerRef}
      />
      <div className="drawer-content">
        <label
          htmlFor="my-drawer"
          tabIndex={0}
          className="btn btn-ghost btn-circle drawer-button"
        >
          <IconBars3 />
        </label>
      </div>
      <div className="drawer-side">
        <label
          htmlFor="my-drawer"
          aria-label="close sidebar"
          className="drawer-overlay"
        ></label>
        <ul className="menu bg-base-200 text-base-content min-h-full w-40 p-4">
          <NavItem to="/" label="Networks" icon={<IconGlobe />} />
          <NavItem to="/settings" label="Settings" icon={<IconCog />} />
        </ul>
      </div>
    </div>
  );

  // https://v5.daisyui.com/components/navbar/#navbar-with-dropdown-center-logo-and-icon
  return (
    <div className="navbar bg-base-200 shadow-sm">
      <div className="navbar-start">
        <SideBar />
      </div>
      <div className="navbar-center">
        <span className="text-2xl font-bold">Zero Knowledge Network</span>
      </div>
      <div className="navbar-end"></div>
    </div>
  );
}
